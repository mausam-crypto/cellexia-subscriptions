# TESTING — E2E test plan on a development store

How to prove the whole machine works before go-live: every customer verb, the
full dunning ladder, gifts, cancel-saves, win-back, i18n, and a load sanity pass.

Related: [INSTALL.md](./INSTALL.md) (get a dev-store install running first),
[MIGRATION.md](./MIGRATION.md), [OPERATIONS.md](./OPERATIONS.md).

Unit/integration tests: `npm test` (Vitest). Pure logic (ladders, tokens, dates,
money, taxonomies) runs without a DB; DB-touching suites skip themselves when
`DATABASE_URL` is unset. The v1.5.0 audit areas carry dedicated regression
suites — `tests/portal-audit.test.ts` (login hand-off, OTP timing, RTL,
dispatcher gates), `tests/cancel-save-guards.test.ts`,
`tests/dunning-ladder.test.ts` / `tests/dunning-double-retry.test.ts` /
`tests/dunning-send-dedupe.test.ts`, `tests/origin-revenue.test.ts`,
`tests/acquisition.test.ts` + `tests/acquisition-capture.test.ts`, and
`tests/risk-learning.test.ts` — so the manual passes below confirm reality;
they are not the only line of defense. The rest of this document is the
*manual* E2E plan.

The buy-box theme extension has its own suite under `tests/liquid/`: a
harness that renders the real `.liquid` files with Shopify's theme-app-extension
semantics (app-snippet comment wrapping, escaped `t` output), golden render
tests, static lint guards for the forbidden Liquid shapes, schema-validity
checks mirroring the Shopify CLI, and — since v1.6.3, corrected in v1.6.4 —
`tests/liquid/size-limits.test.ts`, which enforces the deploy size budgets:
primarily the **TOTAL** Liquid across the extension (a real
`shopify app deploy` verified that Shopify's 100KB limit applies to the sum
of every `.liquid` file, **not** per-file — the guard holds the total at
88KB), plus a per-file belt at the same ceiling, block count, bundle size,
locale-file caps, and our JS/CSS performance ceilings, so oversized Liquid
fails `npm test` instead of `shopify app deploy`.

---

## 1. Setup

1. Create a **development store** in the Partner Dashboard (choose "Test data" /
   developer preview). Dev stores run **Shopify Payments in test mode** out of
   the box (Settings → Payments → confirm "Test mode" is on).
2. Install the app per [INSTALL.md](./INSTALL.md) (a second, staging deploy +
   staging DB is ideal; `MAIL_PROVIDER=console` is acceptable here — OTP codes
   then appear in server logs).
3. Create a plan config (Plans page) with frequencies `[4,6,8]`, default 8,
   20%/10% discounts, sync it, add the buy box block to the theme.
4. **Go live on the dev store**: the app installs in Setup mode (dark — jobs
   skipped, portal closed, buy box hidden). Sections 2–9 exercise the *live*
   behaviour, so on the dev store open **Preview & launch** → **Go live**
   first. Section 10 is the opposite: it runs on the production store *while
   still in Setup mode*.
5. Optional: `npm run seed:demo` seeds demo cadence/gift/plan data for UI work.

## 2. Test cards

<a name="test-cards"></a>

Shopify Payments **test mode** card numbers (any future expiry, any CVC, any
postcode):

| Card number | Behaviour | Use it to test |
|---|---|---|
| `4242 4242 4242 4242` | Always succeeds | Happy-path checkout + renewals |
| `4000 0000 0000 0002` | Declined — `card_declined` (generic) | Failure webhook, dunning case opens |
| `4000 0000 0000 9995` | Declined — `insufficient_funds` | **SOFT** decline branch: full retry ladder + payday alignment |
| `4000 0000 0000 0069` | Declined — `expired_card` | Card-expiry branch + card-update link |
| `4000 0000 0000 3220` | 3D Secure 2 challenge required | `CHALLENGED` webhook → `AWAITING_3DS` → `dunning.threeds_link_sent` magic link |

To exercise a *renewal* failure (not a checkout failure): subscribe with
`4242…4242`, then in Shopify admin → customer → payment methods, or via the
portal card-update flow, replace the card with a failing number before the next
charge.

## 3. Scenario checklist — every customer verb

Work through the portal (`https://<dev-store>/apps/cellexia-subs`) and magic links.
For each row: perform the action, then verify (a) Shopify admin shows the
contract change, (b) the contract timeline (Audit/Subscriber page) logged the
event, (c) the Klaviyo event arrived (or `NotificationLog` row exists).

| # | Verb | Where | Expected event |
|---|---|---|---|
| 1 | OTP login (request + wrong code + right code) | Portal | `portal.otp_sent`, `portal.login` |
| 2 | Skip next cycle | Portal + magic link from upcoming-order email | `cycle.skipped` |
| 3 | Unskip | Portal | `cycle.unskipped` |
| 4 | Delay next cycle (e.g. +2 weeks) | Portal + magic link | `cycle.delayed` |
| 5 | Change frequency (8 → 6 weeks) | Portal | `contract.frequency_changed` |
| 6 | Change next date directly | Portal | `contract.next_date_changed` |
| 7 | Swap variant | Portal | `contract.line_swapped` |
| 8 | Change quantity | Portal | `contract.quantity_changed` |
| 9 | Add a line (second product) | Portal | `contract.line_added` |
| 10 | Remove a line | Portal | `contract.line_removed` |
| 11 | One-time add-on (next box only) | Portal + `ADD_TO_NEXT` magic link | `cycle.addon_added`; line auto-removed after that cycle bills (`cycle.addon_removed`) |
| 12 | Pause (1–3 months) | Portal | `contract.paused`; auto-resume date set |
| 13 | Resume (manual + auto at `resumeAt`) | Portal / scheduler | `contract.resumed` |
| 14 | Update delivery address | Portal | `contract.address_updated` |
| 15 | Update card | Portal → Shopify-hosted card page | `contract.payment_method_updated` (via webhook) |
| 16 | Cancel — complete the full flow | Portal | see §6 |
| 17 | Magic link misuse: expired token, re-used single-use token, tampered token | Browser | Friendly error page, no action performed, nothing logged as used |
| 18 | Restart a cancelled subscription (portal home card, subscription detail, cancel "done" page — all three) | Portal | `winback.reactivated`; contract active again, no discount granted |

While on row 1: the OTP screen must answer identically (same neutral copy,
similar response time) for a subscriber email and a stranger email — the
constant-time anti-enumeration behavior is pinned by
`tests/portal-audit.test.ts`, but eyeball it once. A magic-link login (any
emailed link) must land you in the portal with **no token visible in the
address bar** (the `?handoff=` code is consumed and disappears on the
redirect).

Then verify a **renewal**: set the contract's next date to today (admin →
contract → set next date), wait for a scheduler tick (≤60s internal / ≤5min
external), and confirm attempt → order → `billing.attempt_succeeded`,
`billing.order_created`, `ordersCount` incremented, renewal notification sent.

## 4. Dunning ladder — day 0/3/7/14 simulation

The real ladder (settings key `dunning.softRetryDays`, default `[0,3,7,14]`)
takes two weeks. Compress it for testing:

1. Settings page → dunning → **temporarily** set `softRetryDays` to `[0,0,0]`
   and `paydayAlign` to `false`, `emailLadderDays` to `[0,0,0]`, `smsDay` to `0`.
   Each "day" of the ladder now falls due immediately, so consecutive scheduler
   ticks walk the whole ladder in minutes. **Restore the defaults afterwards**
   (`[0,3,7,14]`, payday align on) — this is exactly the kind of setting
   go-live check #7 exists for.
2. Give a contract the `insufficient_funds` card (§2), set next date = today.
3. Observe, in order: `billing.attempt_failed` → `dunning.case_opened`
   (category SOFT) → `dunning.retry_scheduled` → retries 1..3 failing →
   customer emails at each ladder step (check Klaviyo/`NotificationLog`) →
   `dunning.exhausted` → contract **paused** (default `exhaustedAction: PAUSE`).
4. **Recovery path**: repeat with a fresh contract, but after retry 1 replace
   the card with `4242…4242` via the card-update link from the dunning email →
   next retry succeeds → `dunning.recovered`, case `RECOVERED`, contract stays
   `ACTIVE`, recovered amount recorded.
5. **Backup card path**: put a failing primary + `4242…4242` backup on a
   contract → first retry after failure uses the backup
   (`dunning.backup_used`, attempt flagged `usedBackupPayment`).
6. **Hard decline**: generic `card_declined` counts as SOFT in the taxonomy, so
   use the stolen-card test number `4000 0000 0000 9979` to get a HARD decline →
   verify **no** retry ladder, straight to `AWAITING_CUSTOMER` + a card-update
   link.
7. **3DS**: card `4000 0000 0000 3220` on a renewal → `CHALLENGED` webhook →
   `dunning.threeds_link_sent` → open the magic link, complete the challenge on
   Shopify's hosted page → attempt succeeds.
8. **Pre-expiry notice**: set a card expiring next month (test card with expiry
   = next month), run the daily sweep → `dunning.card_expiring_notice`.

## 5. Gift cycles

1. Gifts page → create rules: `ORDER_INDEX = 2` (surprise gift, announce off)
   and `ORDER_INDEX = 6` (milestone, announce on), plus a `DAYS_SUBSCRIBED = 365`
   anniversary rule. Use a cheap/zero-cost variant as the gift.
2. Bill a contract through cycle 2 (set next date = today repeatedly): the gift
   line (price £0, `isGift`) must appear on the cycle-2 order only —
   `lifecycle.gift_scheduled` → `cycle.gift_added` → order contains the gift →
   gift line absent from cycle 3.
3. Announced milestone: before cycle 6 bills, the "stay subscribed and get X"
   notification goes out (`lifecycle.incentive_announced`).
4. Cancel a gift mid-flight: remove the scheduled grant (admin) →
   `cycle.gift_removed`, order has no gift.

## 6. Cancel-save flows

Run the portal cancel flow once per reason, on separate test contracts:

1. The reason survey must show a visible **"I'd rather not say"** bypass that
   advances the flow without recording a reason.
2. Reason `TOO_MUCH_PRODUCT` → expect skip/frequency-change saves offered
   (`cancel.save_shown`); accept one → `cancel.save_accepted`, outcome `SAVED`,
   contract still active, `savedAt` set.
3. Reason `TOO_EXPENSIVE` → discount save (default 15% × 2 cycles) → accept →
   verify a `DiscountGrant` row and that the **next renewal actually charges
   the discounted amount**. Walk the flow again on the same contract → the
   discount save must NOT be offered again
   (`cancelFlow.reasonOfferCooldownDays`, default 90).
4. **Declining saves cancels immediately** (v1.5.0): "No thanks, continue
   cancelling" → `cancel.completed`, contract cancelled in Shopify,
   `winback.scheduled` appears — no interstitial screen is auto-inserted.
   The final offer (default 25% × 2 cycles, `cancel.final_offer_shown`) must
   appear **only** via the explicit "See my final offer" link on the
   saves/confirm pages — verify it is opt-in, then decline it → cancelled.
5. Re-run the flow on a contract that was already shown the final offer → it
   must NOT appear again (show-once + 180-day cooldown, enforced against the
   event log even across sessions).
6. The "done" page must offer **"Restart my subscription now"** → tap it →
   contract reactivates (`winback.reactivated`) with no discount attached.
7. Count the steps to cancel when declining everything: must be **≤ 3 clicks**
   from "Cancel subscription" to cancelled (FTC click-to-cancel; see
   [OFFER_PLAYBOOK.md](./OFFER_PLAYBOOK.md#save-ladder-ethics)). Abandon a flow
   halfway → outcome `ABANDONED`, contract untouched (the terminal
   `cancel.aborted` event is emitted when a new flow starts, or by the hourly
   `cancel_session_gc` job).

## 7. Win-back

1. Settings → winback → temporarily set offsets to `{softTouch: 0, perk: 0,
   discount: 0, sunset: 1}` days relative to predicted-empty (or set the
   cancelled contract's `predictedEmptyDate` to today via the admin).
2. Cancel a contract (complete flow, §6). Scheduler ticks should emit
   `winback.soft_touch` → `winback.perk_offered` → `winback.discount_offered`
   (magic reactivation link) in sequence.
3. Open the reactivation link → reactivate → `winback.reactivated`, new/resumed
   contract active, win-back state `WON_BACK`. Accepting the discount-stage
   link logs `winback.discount_granted` (not a second `discount_offered`).
4. **Perk-stage link** (v1.5.0 regression): the perk email's link must grant
   the promised **free gift and no discount** — confirmation copy mentions
   the gift, and no bogus 1% grant appears on the contract.
5. Let another one run to `winback.sunset` → no further touches ever. Restore
   the real offsets.

## 8. i18n spot checks (3 languages)

Master catalog is `app/lib/i18n/locales/en.json`; ship-parity across catalogs is
enforced by `tests/i18n-parity.test.ts`. Pick English + the two other languages
enabled on the store (Shopify admin → Settings → Languages — e.g. `fr`, `de`;
the shipped catalogs live in `app/lib/i18n/locales/`).

For each language: switch the storefront language (or set the customer locale),
then spot-check — portal home, skip/delay confirmations, cancel flow copy,
one magic-link landing page, one email (upcoming order), OTP email. Look for:
missing-key fallbacks to English mid-sentence, unformatted `{vars}`, broken
currency/date formatting (dates must localise via the shop timezone, money via
`Intl` with the contract currency).

## 9. Load sanity — billing sweep

Goal: prove a realistic renewal-day spike drains within one tick cadence.

1. On the staging DB, create ~500 contracts due "today" (loop
   `npm run import:subscribers` with a generated CSV against the dev store, or
   `npm run seed:demo` scale flag if available; dev-store rate limits make
   ~500 a sensible ceiling).
2. Trigger the sweep (tick or `POST /api/jobs/run`) and watch the `billing_run`
   `JobRun.stats`: processed count, duration, error count.
3. Pass criteria: the run completes without crashing, processes in batches
   (respecting Shopify API throttling — expect minutes, not seconds), no
   contract is attempted twice (idempotency keys unique), the queue is empty by
   the end and `/api/health` stayed green throughout.
4. Kill the process mid-run once (`flyctl machine restart` / ctrl-C) and re-run:
   **zero duplicate charges** — this is the idempotency guarantee, verify it
   empirically here.

## 10. Preview-based QA (pre-launch, on the live store)

<a name="10-preview-based-qa-pre-launch-on-the-live-store"></a>

The sections above run on a dev store. This pass runs on the **production**
store while the app is still in **Setup mode** — everything below is invisible
to real visitors, so it is safe any time before go-live. All tools are on the
admin **Preview & launch** page.

**Storefront preview** (signed `?cx_preview` link, 7-day validity, reveals the
widget only in your own browser session):

1. Generate a preview link for a product in a synced plan and open it.
   The buy box renders with the "Preview — only you can see this" ribbon:
   subscription option preselected, savings badge, frequency selector,
   correct prices. If the widget does not show, run the **Preview Doctor**
   (same card) — it names the first closed gate on the render chain
   ([OPERATIONS.md §20](./OPERATIONS.md#20-runbook--widget-not-showing));
   `tests/preview-doctor.test.ts` covers each step's PASS/FAIL fixtures and
   the preview action's BLOCKED gate.
2. Repeat on a **mobile** viewport (or your phone — the link works anywhere
   the session carries): layout, tap targets, ribbon visible.
3. Select a plan → add to cart → the **cart line shows the selling plan**
   (frequency + subscription price). The preview follows you from PDP to cart
   without re-appending the token (kept in `sessionStorage`).
4. Proceed to **checkout**: the recurring terms ("every N weeks…") show
   natively on the line item. Abandon before paying, or pay with a test card
   if this store is still in test mode.
5. **Zero-impact check**: open the same PDP in a private window *without* the
   token — no widget, no layout shift. Visit `/apps/cellexia-subs` — the "not yet
   available" page. Audit page: no customer notification sent (anything
   attempted shows as `SUPPRESSED`).

**App-embed checks** (when the buy box is installed via the app embed —
Theme settings → App embeds — rather than as a product-template block; run
these inside the storefront preview session above):

1. **Position**: the widget mounts inside the buy column, **above the
   quantity + add-to-cart panel** (on cellexialabs.com: just above the grey
   panel, right after the size selector) — not at the bottom of the page,
   which would mean the embed failed to find an anchor and never unhid
   itself. If it is missing or misplaced, set the placement selector — see
   [INSTALL.md §11](./INSTALL.md#11-troubleshooting).
2. **Subscription add-to-cart carries the plan**: select the subscription
   option, add to cart, and verify the line **in the cart** shows the selling
   plan (frequency text) at the correct **recurring subscription price** —
   then proceed and verify the same **in checkout** (recurring terms shown
   natively on the line). This is the critical embed path: on themes without
   a `/cart/add` form the embed injects the plan into the theme's AJAX cart
   request, so a silent failure here would sell one-time at full price.
   `https://<store>/cart.js` must show the line's `selling_plan_allocation`
   and the `_cellexia_design` property.
3. **One-time add unaffected**: select one-time (or a product with no plan)
   → add to cart → no selling plan, no `_cellexia_design` property, normal price —
   the theme's own add-to-cart must behave exactly as before the embed.
4. **Theme cart UX intact**: the mini-cart/cart drawer still opens and
   updates normally after both kinds of add, and any other purchase widgets
   on the page (e.g. a bundle app) still add their own products correctly.
5. **Namespace isolation** (cellexialabs.com hosts another app that owns the
   `cx` prefix — this is what made the widget invisible before v1.2.3). In
   devtools on the PDP:
   `document.querySelectorAll('.cx-buybox-embed[data-cellexia-embed]')` must
   return **exactly one** node, and it must be the one inside the buy column
   carrying `data-cellexia-mounted="true"`. Then check the other app is
   untouched: `document.querySelector('.cx.cx--self-contained')` must still be
   in its original place with **no** `data-cellexia-*` attribute on it, and its
   own widget must still render and function.

**Buy-box design QA** (repeat whenever you change the design in the **Buy box
designer** — before launch via the preview link above, after launch on the
live PDP):

1. For **each preset you intend to use**: preview it in the designer, publish,
   then verify the real PDP on **desktop and mobile** — layout, badge,
   savings, prices, and your per-locale text overrides in every storefront
   language you sell in (unset keys must fall back to the stock translated
   copy, never to blanks).
2. **Switch variants** on the PDP — prices, savings and per-delivery amounts
   must follow the selected variant in every preset.
3. Select the subscription option → add to cart → the cart line carries the
   **selling plan** (frequency text visible on the line) *and* the hidden
   **`_cellexia_design` line property** = the active preset key. It is
   underscore-prefixed, so themes and checkout hide it from customers —
   verify it via `https://<store>/cart.js` (JSON) or on the resulting test
   order's line properties. After the order, the Audit page logs
   `widget.design_attributed`.
4. **One-time path unaffected**: select one-time → add to cart → the line has
   **no** selling plan and **no** `_cellexia_design` property, and checkout is the
   theme's normal flow.
5. **Subscription max preset** (v1.6.0) — run these four checks whenever it
   is (or a market resolves to) the active preset; they verify the
   compliance guardrails that keep "quiet" from meaning "hidden":
   - **One-time reachable in exactly one tap**: from page load, a single
     tap/click on the muted "or buy once for …" line below the card selects
     one-time — no expander, no second step. Keyboard/screen-reader pass:
     the options are a proper radio group (arrow keys move between
     subscription and one-time).
   - **Price visible in the link BEFORE selection**: the quiet link itself
     shows the one-time amount while subscription is still selected, and it
     follows variant switches.
   - **Switch-back works**: after selecting one-time, the line shows the
     minimal selected state (check + "One-time purchase — {amount}") and a
     "Switch back to Subscribe & Save" link; tapping it re-selects the
     subscription card. Repeat a few times — state never sticks.
   - **ATC price sync both directions** (theme prints a price in its Add to
     cart button): load → button shows the subscription price; tap the
     quiet link → button reverts to the theme's own one-time price; switch
     back → subscription price again. Then run checks 3 and 4 above in this
     preset: subscription add carries plan + `_cellexia_design`
     (= `subscription_max`); the quiet-link add carries neither.
6. **Per-market presets** (if the Markets card assigns any): the storefront
   preview link shows the market of the **domain you open it on** — open it
   on each assigned market's own domain/URL and confirm that market's
   preset renders (`data-cellexia-preset` on the widget wrapper names the
   resolved preset); confirm your primary domain still renders the main
   design. The designer's "Preview market" select is a client-side replica
   for quick iteration — the storefront check on the real domain is the one
   that counts.
7. Know your rollback before you need it: there is **no unpublish** — once a
   design has been published you cannot return to "no config" from the
   designer, and you don't need to. To get the exact v1.0.0 rendering back,
   **restore the classic revision** from the revision history (or publish a
   fresh classic design with default knobs — classic with defaults *is* the
   v1.0.0 rendering). Restore publishes a new revision; the storefront
   follows within minutes.

**Portal preview** (full portal UI, every mutating action intercepted —
nothing executes, no Shopify calls):

1. **Demo subscription** — one click creates a local-only demo contract
   (`isDemo`, fake `gid://cellexia/demo/...` IDs; excluded from billing,
   reminders, analytics and Klaviyo). Open the preview link (valid 1 hour).
2. The slim "Preview mode" banner must persist on **every** screen. Walk all
   of them: subscriptions list, subscription detail, skip/delay, frequency
   change, swap, quantity, add/remove line, one-time add-on, pause/resume,
   next-date, address, account.
3. On each action, confirm the "Preview mode — this action is disabled" toast
   appears and **nothing changes** (reload — same state; timeline shows no
   contract events).
4. **Cancel flow walk-through**: start the cancel flow and walk every step —
   reason survey, reason-matched saves, final offer, confirm. Every step must
   render; the final confirm is intercepted like everything else and the
   contract stays untouched.
5. After importing real subscribers, preview **a real subscriber** too and
   check their actual products, prices, frequency and next date render
   correctly.
6. **Demo reset**: the demo contract is reused between preview sessions. If
   its data has drifted (products renamed, plan config changed), have the
   developer run `resetDemoContract(shopId)`
   (`app/lib/portal/demo.server.ts`) — it deletes and recreates the demo from
   the current catalog; the next demo preview picks it up.

Both previews auto-tick the corresponding items on the go-live checklist
(the storefront one only when its pre-flight diagnosis ran and passed —
**Open anyway** and a skipped diagnosis leave it unticked).
When this pass is green, go live per
[INSTALL.md §10](./INSTALL.md#10-preview-then-go-live).

## 11. Regression cadence

Before every release ([UPDATE.md](./UPDATE.md)): `npm run verify` green — the
mandatory release gate, running `tsc --noEmit && vitest run && remix
vite:build` in cheap-to-expensive order. The final production-build step
exists because typecheck and all tests once passed on a tree whose
`remix vite:build` failed (a route component referenced a `.server` module —
something neither tsc nor Vitest exercises); green tests alone do not prove a
shippable build. Then re-run §3 rows 1/2/12/16/18, one §4 recovery, and one
renewal end-to-end on the dev store. Quarterly: the full document.

A green `vitest run` prints **no stderr at all**: `vitest.config.ts`
(`onConsoleLog`) suppresses the app's own `[subsystem]`-prefixed error logs,
which error-path tests trigger on purpose. Any stderr that DOES appear in a
test run is therefore unexpected output worth investigating, not known noise
to scroll past. Tests that assert on those logs use `vi.spyOn(console, …)`,
which the output filter does not affect.
