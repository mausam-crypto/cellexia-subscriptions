# OPERATIONS — day-2 runbooks

Runbooks for operating Cellexia Subscriptions in production. Written for the
operator (CX lead / ops) with the developer on call.

Related: [INSTALL.md](./INSTALL.md), [UPDATE.md](./UPDATE.md),
[TESTING.md](./TESTING.md), [OFFER_PLAYBOOK.md](./OFFER_PLAYBOOK.md).

Everything below happens in the embedded admin (Shopify admin → Apps → Cellexia
Subscriptions) unless a shell command is shown.

---

## 1. Daily ops tour (5 minutes, every morning)

1. **Dashboard** — the "This week" insight cards (plain-language findings, at
   most 5 — read these first), then the headline tiles: active subscribers
   (+ paused), MRR, new vs churned this week, failed payments queue
   (+ recovered this month), each with a week-over-week delta; below them the
   90-day MRR trend, the 12-week new-vs-churned chart, the forecast teaser
   (with its accuracy grade chip) and the top open failed payments.
2. **Debug** — the self-check verdict chip should read **Healthy**. The same
   28 checks re-run automatically every 30 minutes (`selfcheck_run`, also in
   setup mode); a **Broken** verdict raises one CRITICAL `SELF_CHECK_FAILED`
   alert (emailed to Settings → alerts → `emailTo`) and every failing row on
   the page carries a named fix. The alert auto-resolves when a later run
   comes back clean — the checks page, not the alert row, is the live truth.
3. **Alerts** — unresolved alerts (`BILLING_RUN_FAILED`, `WEBHOOK_FAILURES`,
   `ORIGIN_BACKFILL_FAILURES`, `STUCK_CONTRACTS`, `FAILURE_SPIKE`,
   `CHURN_SPIKE`, `FAST_SHIPPING_SKIPS`, `STOCKOUT_RENEWALS`,
   `FOREIGN_CONTRACTS`, `KLAVIYO_OUTBOX_BACKLOG`, `SELF_CHECK_FAILED`).
   Triage per the runbooks below;
   resolve when handled. Critical alerts also email everyone in Settings →
   alerts → `emailTo`. `FOREIGN_CONTRACTS` (severity WARNING, raised while any
   contract on the store belongs to another subscription app or is still
   unattributed) is informational — see §18; it is not an incident.
4. **Dunning** — open cases, sorted by next retry. Sanity-check the queue size
   against yesterday (see §5).
5. **Audit** — skim the event stream for anything unusual (bursts of
   `billing.attempt_failed`, `notification.failed`, webhook failures).
6. External: your uptime monitor on `/api/health` (§12) should be green.

## 2. Runbook — "Billing run failed" alert

Meaning: the `billing_run` job itself crashed (not: individual cards declined —
those are normal dunning).

1. Alerts page → open the alert → context shows the JobRun error.
2. Check `/api/health` and host logs (`flyctl logs`). Typical causes: DB
   connectivity blip, Shopify API outage/throttle, bad deploy.
3. Fix the cause (or wait out the outage). The scheduler retries every tick;
   the run is **idempotent** — every attempt carries an idempotency key
   (`{contractId}:{cycleIndex}:{attemptNumber}`) that Shopify dedupes, so re-runs
   can never double-charge.
4. Confirm a subsequent `billing_run` JobRun shows `SUCCESS` and due contracts
   drained (Dashboard → due today = 0 by end of day). Resolve the alert.

## 3. Runbook — webhook failure spike

Meaning: `WebhookReceipt` rows with status `FAILED` above threshold, receipts
stuck claimed-but-unfinished (`processedAt` NULL for over 15 min — the process
died mid-handler and Shopify's same-id retries have not re-driven it), or
Partner Dashboard shows delivery failures.

1. Audit page → filter webhook failures → read the stored `error` per receipt.
   Stuck receipts carry no error; a manual redelivery from the Partner
   Dashboard (or the nightly sync) re-drives the idempotent handler.
2. Bad HMAC → `SHOPIFY_API_SECRET` mismatch (was the secret rotated in the
   Partner Dashboard?). Fix the env secret and redeploy.
3. Handler exceptions → the payload and error are stored; escalate to the
   developer with the receipt id.
4. If webhooks stopped **arriving entirely**: someone deployed config without
   `npm run deploy`, or the app URL changed. Re-run `npm run deploy`
   ([INSTALL.md §11](./INSTALL.md#11-troubleshooting)).
5. After the fix: state is self-healing — contract webhooks are mirrors, and the
   nightly sync (`syncContractFromShopify`) reconciles anything missed. For a
   targeted fix, open the affected subscriber → **Re-sync from Shopify**.

## 4. Runbook — stuck contracts

Meaning: `STUCK_CONTRACTS` alert — contracts past `nextBillingDate` by more than
`alerts.stuckContractHours` (default 24) with no successful or pending attempt.

1. Subscribers page → filter "Overdue". For each contract check the timeline
   (events) — the last event usually names the blocker:
   - `billing.attempt_failed` + open dunning case → not stuck, it's in dunning.
   - No attempt at all → was the scheduler down? Check JobRun history around the
     due time; once the scheduler runs, it picks the contract up.
   - `stockout.delayed` repeatedly → see §8.
   - Attempt `PENDING` for hours → Shopify never sent the result webhook; the
     stale-attempt sweep re-queries and settles it, or use **Re-sync from
     Shopify** on the contract.
2. As a last resort use **Bill now** (admin manual attempt) on the contract page
   and watch the result arrive on the timeline.

## 5. Dunning queue review cadence

- **Daily**: queue size and states (`RETRYING` vs `AWAITING_CUSTOMER` vs
  `AWAITING_3DS`). A growing `AWAITING_CUSTOMER` pile means card-update emails
  aren't landing — check Klaviyo flow + `notification.failed` events.
- **Weekly**: recovery rate on the Analytics tab (target 55–70%, see
  [OFFER_PLAYBOOK.md](./OFFER_PLAYBOOK.md#target-metrics)). Review `EXHAUSTED`
  cases: default exhausted action is **PAUSE** (settings key `dunning.exhaustedAction`),
  so these customers are paused, not lost — they feed win-back.
- **Monthly**: review the ladder itself (Settings → dunning). `softRetryDays`
  default `[0,3,7,14]`, payday alignment on (`paydaysOfMonth` `[1,15,25]`,
  snap window 3 days). Change only with data; see the playbook.
- **"Retry now" is always safe** (v1.5.0): ladder rungs are selected by time
  elapsed since the failure, not by attempt count, so a manual retry (or the
  automatic retry after a card update) never consumes a configured rung or
  drags exhaustion earlier. Cases are **per billing cycle** — if a second
  cycle fails while an older case is open, the old case closes as
  `SUPERSEDED` and the new one gets a fresh ladder. Admin case actions
  ("Retry now", "Send card link", "Mark resolved", "Cancel") only act on a
  case that is still **open**: if the recovery webhook resolved it while your
  page was stale, the click refuses with "already resolved — refresh the
  page" instead of re-opening a paid case.
- Never retry a **HARD** decline manually (stolen/invalid card) — the engine
  won't either; the customer must update the card.

## 6. Issuing refunds

Refunds are a **Shopify admin** operation, not an app operation:

1. Shopify admin → Orders → the renewal order → **Refund**.
2. The app hears about it via the `REFUNDS_CREATE` webhook and records it
   (idempotently, per refund id) against the billing attempt that charged the
   order. All revenue analytics are **net of refunds**: the daily rollup
   counts the refund on the day it was recorded (closed days are never
   rewritten), cohort/LTGP cells net it against the charge's month, and the
   subscriber's lifetime revenue is reduced. Refunds on non-renewal orders, or
   on another app's contracts, are ignored. The subscription itself is
   untouched — cancel/pause separately if the customer is leaving (ideally
   through the cancel flow so a reason is recorded).
3. For "refund + appease": prefer a **discount grant** (§7) or a **gift** on the
   next cycle over cash where the relationship is salvageable.

## 7. Applying manual credit (DiscountGrant)

To give N% off the next N renewals (appeasement, VIP, damaged parcel):

1. Subscribers → open the contract → **Grant discount**.
2. Type `MANUAL`, percent, number of cycles, and a reason (the reason lands in
   the audit trail; `grantedBy` records your admin email).
3. The grant is applied to upcoming cycles via billing-cycle contract edits —
   **never discount codes** (codes on renewals are forbidden by design, Golden
   rule 3). It decrements `cyclesRemaining` each successful cycle and expires
   itself.
4. Stacking guard: total discount is capped by settings key
   `discountStacking.maxTotalDiscountPct` (default 45%).

## 8. Mass skip during a stockout

Default stockout policy (Settings → stockout) is `DELAY` (7 days, max 2 delays,
customer notified). When a hero SKU will be out for weeks:

1. **Bulk ops** page → **Stockout action** → pick the product/variant → preview
   the affected upcoming cycles.
2. Choose **Skip cycle + notify** (customers keep their schedule, this cycle is
   skipped — `cycle.skipped` + `stockout.skipped` events, Klaviyo notification),
   or **Delay N days**, or **Substitute** (uses `ProductCadence.substituteVariantId`
   — set it first).
3. Execute; the run reports per-contract results. Spot-check 3 contracts'
   timelines.
4. When stock returns, clear the per-product override so the shop default
   applies again. Watch the `STOCKOUT_RENEWALS` alert resolve.

## 9. Price change with notice (bulk flow)

Policy lives in Settings → `priceChangePolicy` (default `GRANDFATHER`: existing
subscribers keep their price; new contracts get the new price). To **propagate**
a price increase properly:

1. Update the variant price(s) in Shopify admin first (affects new subscriptions
   immediately).
2. **Bulk ops** → **Price change batch** → mode `PROPAGATE_WITH_NOTICE`, notice
   period (default 30 days; legal minimum for your market may be longer), select
   variants → the batch computes affected contracts and old→new prices.
3. **Send notices** — batch status `DRAFT → NOTICE_SENT`; every affected
   subscriber gets the price-change notification with their date and new price.
4. On the effective date the batch applies automatically (`NOTICE_SENT → APPLIED`),
   updating contract lines and logging `contract.price_propagated` per contract.
   Contracts flagged `grandfatheredPricing` are excluded.
5. Expect a small cancel bump; the cancel-flow reasons (`TOO_EXPENSIVE`) tell you
   if it was too aggressive.

## 10. Secret rotation

<a name="secret-rotation"></a>

| Secret | Effect of rotating | Procedure |
|---|---|---|
| `APP_SIGNING_SECRET` | **Invalidates every outstanding magic link, portal preview link (`?cx_pp=`), portal session and pending OTP immediately.** Links already sitting in customers' inboxes (skip links in upcoming-order emails, card-update links in dunning emails) will show "link expired". **Also invalidates admin-entered credentials** (Settings → Email delivery / Klaviyo connection — they are encrypted under a key derived from this secret): delivery falls back to the env vars, never crashes, and the Debug self-check surfaces it. | Rotate only on suspicion of compromise or scheduled hygiene. Do it at a low-traffic hour: set the new value, restart. Then **send fresh links**: Bulk ops → re-send card-update links for all open dunning cases, and accept that pre-rotation upcoming-order emails will route customers to the portal login instead — store-account sign-in always works. **Re-enter the SMTP password and Klaviyo key on the Settings page** if they were configured there. |
| `CRON_SECRET` | External cron gets 401s until updated. | Set new value on host **and** in the cron service in the same minute. Internal-scheduler installs: no urgency. |
| `SHOPIFY_API_SECRET` | Webhook HMACs + app-proxy signatures fail → webhooks rejected, portal 401s. | Rotate in the Partner Dashboard, update the host secret immediately, redeploy. Verify a webhook arrives and `/apps/cellexia-subs` loads. |
| SMTP / Klaviyo keys | Notifications fail (contained — billing unaffected). With the Klaviyo key absent, lifecycle **emails** fall back to plain direct-SMTP delivery, **SMS is not sent at all**, and outbox rows are aged out (DEAD) after 24h rather than fired late; a stalled/dying outbox raises `KLAVIYO_OUTBOX_BACKLOG`. | Since v1.12.0 the fastest path is the admin: **Settings → Email delivery / Klaviyo connection** (Test buttons included) — saved values win over the env vars and apply without a restart: mail on the next send, Klaviyo on the next `klaviyo_flush` tick (a minute with the internal scheduler; up to your cron interval with `SCHEDULER_MODE=external`). Env-var installs: update, restart. Either way, confirm the outbox drains and `notification.sent` events resume; resolve the `KLAVIYO_OUTBOX_BACKLOG` alert once it stops re-raising. |

## 11. GDPR requests

Shopify sends three mandatory webhooks; the app handles them automatically and
records receipts:

- `customers/data_request` → the app compiles what it holds (contract mirror,
  events, notification log) and raises an alert so the operator can attach it to
  the reply within the 30-day window. The formal response to the customer is
  yours to send.
- `customers/redact` → PII on that customer's rows is anonymised (email/phone/
  name/address), keeping anonymous rows for financial reporting. Since
  v1.5.0 this also erases every acquisition field (`acq*` columns, the
  `acqRaw` bundle and the `acquisition.captured` event payloads — see
  [DATA_FOUNDATION.md](./DATA_FOUNDATION.md)); the origin-order *money*
  fields are retained (financial records, no personal data).
- `shop/redact` → arrives 48h after uninstall; wipes shop data.

Manual GDPR requests (email/DSAR) about a subscriber: use Shopify admin's
customer data request tooling so the webhook path above fires — do not hand-edit
the app database.

## 12. Database backups

<a name="database-backups"></a>

The database holds everything Shopify doesn't: dunning state, gifts, grants,
events, analytics, magic links. Losing it does not lose contracts (Shopify has
them) but loses the extension state.

- **Fly Postgres**: daily snapshots are automatic; check retention with
  `flyctl postgres backup list -a cellexia-db`. Neon/Railway/Render: enable the
  provider's automated backups (point-in-time if offered).
- Additionally take a weekly logical dump off-host:

  ```bash
  pg_dump "$DATABASE_URL" -Fc -f cellexia-$(date +%F).dump
  ```

  and before every update ([UPDATE.md §4](./UPDATE.md#4-update-procedure)).
- Restore drill once a quarter: `pg_restore` into a scratch DB, point a local
  app at it, confirm the Subscribers page renders.

## 13. Monitoring /api/health with UptimeRobot

`GET /api/health` returns 200 with a JSON body covering DB reachability and
scheduler liveness (last job tick); it returns non-200 when a subsystem is down.

The admin **Debug** page is the wide companion to this endpoint: where
`/api/health` answers "is the process alive" for an external monitor, the
Debug self-check probes 28 feature-level facts on the live store (billing
pipeline shapes, dunning cases, the portal fetched through the real app
proxy, webhook delivery evidence, granted API scopes, secrets, Klaviyo
outbox, settings integrity) every 30 minutes and emails on a broken verdict
via the `SELF_CHECK_FAILED` alert. Use `/api/health` for paging, the Debug
page for diagnosis.

UptimeRobot setup: **Add monitor** → type *HTTP(s)* → URL
`https://<app-host>/api/health` → interval 5 minutes → alert contacts = the same
people as Settings → alerts `emailTo`. Optionally add a *Keyword* monitor
checking the body for `"ok"` so a 200-but-degraded response still alerts.
For external-cron installs, also enable failure alerts on the cron service
itself — a silently dead cron is the most dangerous failure mode this app has
(billing just… stops).

## 14. Runbook — launch mode

<a name="14-runbook--launch-mode"></a>

The app has two launch modes: **Setup** (installed dark — no customer-visible
behaviour) and **Live**. See [INSTALL.md §10](./INSTALL.md#10-preview-then-go-live)
for the original go-live; this section is the day-2 view. If a second
subscription app is installed on the store, read §18 too — going live never
touches its subscribers, and the go-live checklist says so with a warning row.

**Checking the current mode.** The **Preview & launch** page shows a
Setup/Live badge plus the go-live checklist state. Under the hood it is the
settings key `launch` (`mode`, `wentLiveAt`) mirrored into the shop metafield
`cellexia.launch_status` (`"setup"` / `"live"`) — the metafield is what the
buy-box Liquid reads. Mode flips are on the Audit page as `admin.action`
events (`go_live` / `revert_to_setup`).

**Emergency revert to Setup.** Preview & launch → **Revert to setup**. Use it
as a kill switch when something is badly wrong (runaway notifications, a bad
plan sync charging wrong prices). What it does, immediately:

- **Stops**: billing runs, dunning retries, upcoming-order reminders, pause
  auto-resume, gifts, win-back, consolidation, pre-expiry notices, lifecycle
  milestones — the jobs still tick but record themselves as
  `skipped: setup_mode`. Customer notifications are suppressed (logged
  `SUPPRESSED`; only OTP codes, operator alerts and import summaries still
  send) and no new Klaviyo events are enqueued. The public portal closes
  behind the "not yet available" page.
- **Keeps running**: analytics rollups/cohorts/churn risk, the stale-attempt
  sweep, alert scans, and the Klaviyo outbox flush of events enqueued before
  the revert. Webhooks keep arriving and the contract mirror stays in sync.
- **Does NOT stop Shopify-side native flows**: selling plans stay synced, so
  checkout with a subscription plan still works natively for anyone who
  somehow has the widget cached in an open tab — the metafield flip hides the
  widget within minutes (online-store rendering caches metafields briefly),
  it cannot un-render a page a visitor already loaded. Existing contracts
  remain ACTIVE in Shopify; Shopify itself never charges them (this app
  drives billing), so nobody is billed while you are back in Setup — but
  their due dates keep passing. Every day in Setup grows an overdue backlog;
  when you go Live again the go-live modal lists the overdue contracts and
  offers to stagger them over 3 days. Take the offer.

**Preview links.** Storefront preview links (`?cx_preview=…`) are signed
tokens valid **7 days** and are never consumed — the same link works across
PDP/cart visits for its lifetime. When one expires, re-generate it from the
Preview & launch page (also the fix for a link that was shared too widely:
old links die at their TTL; there is nothing to revoke server-side ahead of
that, so treat them as private). Portal preview links (`?cx_pp=…`, since
v1.7.0) work the same way on the portal side: a signed, stateless token valid
**1 hour**, multi-use within that hour, opening the portal directly on the
store domain. The token in the URL *is* the session — Shopify's app proxy
strips cookies, so nothing is stored in the browser — and it is read-only by
construction: every mutating action is intercepted server-side. An expired
link shows a named "this preview link has expired" page; re-generate from
Preview & launch.

**Portal sign-in on a live store.** Customers sign in with their **store
account** (`/account/login` → back to the portal): the app proxy appends
Shopify's signed `logged_in_customer_id` to every proxied request, which the
portal accepts as the customer identity — no app cookie is ever involved.
The email → OTP-code flow depends on cookies the app proxy strips in both
directions, so it can never work on a real store; it survives only for the
local dev harness behind `PORTAL_COOKIE_DEV=1` (see `.env.example`).

**Preview opened but the widget is not there?** That is the
[§20 "Widget not showing?" runbook](#20-runbook--widget-not-showing): run the
Preview Doctor first.

## 15. Runbook — buy box design

<a name="15-runbook--buy-box-design"></a>

**Where the config lives.** Buy-box designs are append-only revisions
(`WidgetDesignRevision`) in the app database; the latest *published* revision
is the live design. Publishing mirrors the config JSON to the shop metafield
`cellexia.buybox_design`, which the theme block reads null-safely on every
page load. The DB is the source of truth and the metafield is the published
copy — if the metafield write fails, the publish rolls back, so the two never
diverge silently. With no published revision (or an invalid stored one) the
widget renders the v1.0.0 classic design. Every publish/restore is an
`admin.action` event on the Audit page.

**How restore works.** Buy box designer → revision history → **Restore**.
Restore copies the old revision's config into a *new* revision and publishes
it — history is never rewritten — refreshing the metafield; the storefront
follows within minutes (online-store rendering caches metafields briefly).
There is no "unpublish": to return to the v1.0.0 look, restore the classic
revision (classic with default knobs *is* the v1.0.0 rendering).

**Markets card — a different preset per Shopify Market (v1.6.0).** The
designer's **Markets** card lists every market on the shop (fetched live from
the Admin API; the shop's primary market is tagged). Each row has a preset
select whose first option is **"Default (use main design)"** — leave it there
and that market renders the main design; pick a preset and only the *preset*
changes for that market. Colors, text, layout, behavior, placement and theme
sync are always shared with the main design. The choices save into the same
draft and publish with the same **Publish** button as everything else (one
revision, one metafield, one restore path — market choices are part of design
history like any other knob). Operational notes:

- **Resolution on the storefront**: the widget matches the visitor's market
  handle (`localization.market.handle`) against the published entries. No
  entry for that market, no market reported by the theme, or an entry whose
  preset the widget doesn't recognise → the **main preset** applies. The
  fallback always inherits; it never blanks the widget.
- **The theme-editor emergency override wins over everything**: forcing a
  preset via the block's **Design** setting (see above) ignores the whole
  published config, market entries included — remember to set it back.
- **Deleted markets**: a saved entry whose market no longer exists on the
  shop is listed on the card with a "Not on your shop anymore" badge; it is
  harmless (no visitor resolves to it) — pick "Default" on its row to remove
  it. If the markets fetch itself fails, the designer still loads and works;
  saved entries are never deleted by a failed fetch (they may temporarily
  show under the stale badge until the next successful load).
- **Previewing per market**: the designer's preview pane has a **Preview
  market** select — a client-side replica showing which preset each market
  resolves to (nothing published). For the real thing, remember the
  **storefront preview link shows the market of the domain you open it on**:
  to QA the market you switched, open the preview link on *that market's
  domain/URL* (e.g. its subfolder or country domain), not on your primary
  domain.
- **Take-rate reporting stays per-design automatically**: the
  `_cellexia_design` attribution carries the *resolved* preset, so a market
  running its own preset reports under that preset's key on the performance
  card — that is what makes the one-market rollout discipline in
  [OFFER_PLAYBOOK.md §9](./OFFER_PLAYBOOK.md#subscription-max) measurable.

**Widget looks wrong after a theme change** (theme update, new theme,
rebuilt product template):

1. **Emergency override in the theme editor**: the block's **Design** setting
   (`design_source`) defaults to "App design". Forcing a preset there ignores
   the published config entirely and renders that preset with default knobs —
   force **classic** to get the stock v1.0.0 rendering while you investigate.
   Set it back to "App design" afterwards.
2. **Republish** the current design from the designer to refresh the
   metafield — this fixes a stale or manually deleted metafield.
3. If the design's **custom CSS** is the culprit (it is scoped to the widget
   wrapper, but a theme change can change what it targets), clear the custom
   CSS field and republish.
4. Still wrong → the rebuilt template may simply have dropped the block;
   re-add it per [INSTALL.md](./INSTALL.md) §7.

## 16. Buy box embed

<a name="16-buy-box-embed"></a>

When the buy box is installed as the **app embed** (Theme settings → App
embeds, [INSTALL.md §7](./INSTALL.md#7-theme-setup-buy-box--portal-proxy))
rather than as a product-template block, it finds its own place in the page
at load time. Two things to know:

**Placement precedence.** The mount anchor is resolved in this order — the
first one set wins:

1. the embed's **Custom anchor selector** setting in the theme editor;
2. the designer's **Placement** section (published design config —
   "Custom CSS selector" + position);
3. **automatic heuristics** (tuned first for cellexialabs.com — insert just
   above the grey quantity/ATC panel — with generic fallbacks for standard
   OS 2.0 themes and `/cart/add` forms).

So a selector typed into the theme editor silently overrides whatever the
designer publishes — if a placement change from the designer seems to have no
effect, check the embed's own setting first. If the section app block is also
present on the page, the embed stays dormant entirely (the block wins).

**After a theme redesign** (new theme, rebuilt product template, renamed CSS
classes): re-check the anchor. Open a storefront preview link on a
subscription product and confirm the widget still mounts above the
add-to-cart area. A redesign can invalidate both the automatic heuristics and
any explicit selector; if the widget is missing or misplaced, update the
selector (designer → Placement, or the embed setting) to a stable element in
the new markup and publish/save. Unmounted embeds fail safe — the widget
simply stays hidden (with a hint card in preview sessions and a console
warning) — but that means a silent theme redesign can silently remove your
subscription offer: add the placement check to any theme-release checklist.
(For a widget that is missing for any *other* reason, start with the Preview
Doctor — [§20](#20-runbook--widget-not-showing).)
Also re-run the app-embed cart checks in
[TESTING.md §10](./TESTING.md#10-preview-based-qa-pre-launch-on-the-live-store)
after a redesign — the embed injects the selling plan into the theme's cart
requests, and a new theme means a new cart implementation.

## 17. Buy box — theme add-to-cart price sync

<a name="17-buy-box--theme-add-to-cart-price-sync"></a>

Many themes print the price **inside their own Add to cart button** ("ADD TO
CART - CHF 64.00"). That number is the one-time price, so with the
subscription option selected the shopper reads CHF 51.20 in our widget and
CHF 64.00 on the button they are about to click. The buy box fixes that
itself: while subscription is selected it replaces the one-time **money
string** with the subscription first-order one inside that button's text, and
puts the theme's own text back the instant one-time is selected (or the widget
is hidden, launch-gated or unmounted). It never changes what is added to the
cart — the cart line is decided by the `selling_plan` field, not by button
copy — and it re-applies automatically when the theme rewrites the label on a
variant change. Since v1.11.0 the same swap also covers the theme's **main
price display** — the price under the product title, which otherwise keeps
quoting the one-time price while the subscription is selected. Struck-through
compare-at prices and per-unit lines are deliberately left untouched.

**Where to switch it on/off:** Buy box designer → **Theme integration** —
two checkboxes: "Match the theme's Add to cart price to the selected option"
and (v1.11.0) "Match the theme's main price display to the selected option"
(published with the rest of the design, so no theme edit or redeploy). Both
are **on by default**, including for shops that never published a design and
for designs published before v1.11.0 (a missing key means on).

**It is silent by design.** The swap only ever happens when the button's text
literally contains the one-time money string, formatted with the shop's own
`money_format`. A theme whose button reads just "Add to cart" is left
untouched, with no warning and no console noise — there is nothing to fix.

**The button's (or the main display's) price is not updating** (it still
shows the one-time price with subscription selected):

1. Confirm the toggle above is on and the design is **published** (not just
   saved as a draft).
2. Check the button actually prints a price, and that it matches the shop's
   money format exactly — a theme that renders "CHF 64.-" or "64.00 CHF" while
   Settings → Store details formats as "CHF 64.00" will never match, and
   nothing can be done from here except aligning the theme's own formatting.
3. Set a **custom selector**: Buy box designer → Theme integration → "Add to
   cart button selector". Find it in the browser's inspector on a product
   page, then verify it in the console before saving:
   `document.querySelectorAll('.pdp__actions .btn--atc')` should return the
   add-to-cart button (and nothing else). `.pdp__actions .btn--atc` is the
   correct value for the Sleepify theme on cellexialabs.com; the built-in list
   also covers `button[name="add"]`, `.product-form__submit`,
   `[data-add-to-cart]` and `.btn--atc` (Dawn / OS 2.0 and most themes). The
   main price display has its own escape hatch right below — "Main price
   selector" — with the same rules; its built-in list is `.pdp__price` (the
   Sleepify value on cellexialabs.com), `.product__price`, `.price__regular`,
   `.product-price` and `[data-product-price]`.
4. Re-check after any theme redesign, exactly like the embed's placement
   anchor (§16) — renamed CSS classes invalidate a custom selector.

**The wrong element changed** (e.g. a price in the header or the cart drawer):
this should be impossible — targets are only looked for inside the widget's
own product area; the header/nav/footer/cart-drawer regions and every Cellexia
widget are excluded outright (v1.2.3); and nothing is written at all unless
the target literally contains the theme's own one-time money string. If it
happens, switch the toggle off, republish, and report it with the theme name
and the selector in use.

**Emergency off switch.** Toggle off + Publish is instant and needs no theme
work. Reverting to a design revision published before v1.2.2 also works: the
setting simply defaults back to on, so if the goal is "off", use the toggle.

## 18. Running alongside another subscription app (e.g. Joy Subscriptions)

<a name="18-running-alongside-another-subscription-app"></a>

cellexialabs.com runs **Joy Subscriptions** as well as this app. Shopify sends
every subscription webhook to **every** subscription app on the store, so Joy's
contracts arrive here on the same `SUBSCRIPTION_CONTRACTS_*` webhooks as ours
and are mirrored into the database. They are visible on purpose — you have to
be able to see what is on your store — but nothing automatic ever touches them.

**The `ownership` column** on each contract is the whole mechanism. Three
values:

| Value | Meaning | What the app does with it |
| --- | --- | --- |
| `OURS` | A line on the contract carries one of **our** selling plan ids, or our own import created it, or an admin claimed it. | Everything: billing, dunning, reminders, emails/SMS, Klaviyo, analytics, the customer portal, the support cockpit. |
| `FOREIGN` | Every line carries a selling plan and **not one is ours** — positive evidence it belongs to another app. | Nothing. Never billed, dunned, emailed, sent to Klaviyo, counted in analytics, or shown in the portal, and the support cockpit refuses every action on it. |
| `UNKNOWN` | Ownership could not be proven (no selling plan on any line, or our own plan ids were not readable at the time). | Treated exactly like `FOREIGN` — the indeterminate case fails safe. |

Only `OURS` is ever acted on. That is enforced in the queries themselves, not
in the UI, so it holds for anything that reaches the database.

**Where to see it.** Preview & launch → **Other subscription apps** (counts per
category, plus the other app's selling plan groups and the products they sit
on), and the Subscribers list, which shows the owner per row and can filter to
the unattributed ones.

**What is isolated, and what is not.** Isolated by the `ownership` column, with
no configuration on your part:

| Isolated (the other app's subscribers are untouched) | Not isolated (your job) |
| --- | --- |
| **Billing** — the renewal sweep, the stale-attempt sweep and every retry are `OURS` only. Cellexia never charges a card for a contract it does not own. | **The product page.** Both apps attach a selling plan group to the same product, and each app renders its own widget. Cellexia renders only its own group (or nothing); it cannot switch the other app's widget off. Do that in the other app before go-live, or the PDP shows two subscribe options. |
| **Emails and SMS** — reminders, dunning, card-expiry, win-back, cancel-save. `send.server` refuses to message a contract that is not `OURS`, so a Joy subscriber can never receive a Cellexia email about their Joy subscription. | **Checkout and order emails** are Shopify's, shared by both apps as usual. |
| **Klaviyo** — nothing is enqueued for a contract that is not `OURS`, so no flow can fire at another app's customer. | **Reporting outside the app** (Shopify's own subscription reports, your BI) counts both apps together unless you split it yourself. |
| **Analytics** — rollups, cohorts, LTGP, survival, churn risk, forecast, take rate and every dashboard tile count `OURS` only, so their subscribers never inflate your numbers. | **Inventory and fulfilment** are shared — both apps create real orders on the same stock. |
| **Customer portal** — a subscriber whose contracts are all the other app's sees nothing here: they can sign in with their store account (that is Shopify's login, not ours to refuse), but the portal lists `OURS` contracts only, so it shows the empty "no subscriptions yet" state. Send them to the other app's portal. | |
| **Support cockpit and bulk ops** — every action on a `FOREIGN`/`UNKNOWN` contract is refused server-side, including *Charge now*. | |

**What going live does to the other app's subscribers: nothing.** Go-live flips
our launch mode, republishes our allow-list metafield, re-attributes contracts
and (optionally) staggers *our own* overdue renewals. It does not create,
cancel, reschedule or charge a single contract that is not `OURS` — the overdue
list the modal offers to stagger is `OURS`-filtered, and staggering is the only
thing on that path that writes to Shopify. Joy keeps billing its subscribers on
its own schedule, exactly as before, and they hear nothing from us.

**After updating to 1.3.0 — do this before going live.** The migration that
adds the column cannot tell whose contracts the existing mirrors are (the
evidence columns are added by the same migration), so it marks **every
pre-existing contract `UNKNOWN`**. That is deliberate: nothing is billed until
it is positively identified, so the update cannot charge Joy's subscribers.
It also means **our own** subscribers sit in `UNKNOWN` and are not billed
either, until you run:

> Preview & launch → **Re-check subscription ownership**

It reads each contract back from Shopify, records the selling plan on its
lines, and files it as `OURS` or `FOREIGN`. **Going live does this
automatically**, before the mode flips, and it sweeps the whole shop rather
than one capped batch — so a normal go-live needs no extra step, whatever the
shop's size. The button is for shops that are already live, for re-running
after a Shopify hiccup ("N could not be read from Shopify" in the toast), and
for checking the result before committing.

**How to know it is finished.** Each run makes at most 1 000 Shopify
re-fetches, and straight after the update every pre-existing contract needs
one, so a shop with more than 1 000 subscriptions takes more than one run. The
toast ends with the number still **unattributed**; when that is 0, the shop is
fully attributed and there is nothing left to do. If it is not 0, run it again
— it picks up where it left off (the pass takes the still-unattributed rows
first). Anything still waiting is simply not billed yet: a renewal is delayed,
never charged twice.

Contracts that came in through our own CSV import (or the Import page) carry no
selling plan at all, so the pass has nothing to decide them with. Imports run
by 1.3.0 and later are stamped as ours at creation and need nothing; anything
imported by an earlier version stays `UNKNOWN` after the pass and must be
claimed: Subscribers → **Managed by: Unattributed** → select → **Claim as
Cellexia's**. Claiming only ever promotes `UNKNOWN` → `OURS`, logging one
`admin.action` per contract; a contract positively identified as another app's
is never flipped (take it over properly instead —
[MIGRATION.md §5](./MIGRATION.md#5-migrating-off-another-subscription-app-that-stays-installed)).

**Taking a subscriber over from the other app.** Cancel the subscription in
that app first, then re-create/import it here. Never leave both apps believing
they own the same subscription — that is a double charge to a real customer,
and it is the one failure this design refuses to make possible by accident.
The step-by-step (export → import → cancel in the other app → claim) is
[MIGRATION.md §5](./MIGRATION.md#5-migrating-off-another-subscription-app-that-stays-installed).

**Before you uninstall the other app.** Uninstalling it does **not** move its
subscribers to us — it stops *its* billing, and ours never started, so those
customers simply stop being charged and stop receiving product. Work through
this first:

1. Export its subscribers (email, variant, interval, next charge date, price,
   address, payment method) — after uninstalling, that export is gone.
2. Migrate them per [MIGRATION.md §5](./MIGRATION.md#5-migrating-off-another-subscription-app-that-stays-installed):
   cancel in the other app, import here. The importer stamps `OURS`, so
   imported rows are billable as soon as you are live.
3. Subscribers → **Managed by: Unattributed** → confirm nothing is left that
   should be ours, and **Claim as Cellexia's** anything that is.
4. Subscribers → **Managed by: Another app** + **Status: ACTIVE** → this must
   be **empty**: every one of their live subscriptions is cancelled or
   migrated. (The *Other subscription apps* card counts contracts of every
   status, so its `Another app` number stays above zero — cancelled mirrors
   are history, not a problem.)
5. Check that their selling plan groups are gone from your products (same card,
   "Subscription plans on this store that are not Cellexia's"). A leftover
   group keeps
   rendering their now-unmanaged widget on the PDP; removing the app usually
   removes the groups, but verify.
6. Only then uninstall. Cancelled contracts stay in our mirror as `FOREIGN`
   history — that is fine, nothing acts on them.

**"A customer says their login code never arrives."** Check Subscribers: if
their contract is `FOREIGN`, they are the other app's customer and our portal
deliberately refuses them (no code, neutral copy, no account enumeration).
Point them at the other app's portal, or migrate them over first. If it is
`UNKNOWN`, it is ours-but-unproven: run *Re-check subscription ownership*, then
claim it — and they can log in immediately after.

**The buy box on a shared product.** The widget renders **our** selling plan
group or nothing at all; it never renders another app's. It picks the group by
id *and* by the selling plan ids inside it, both from the allow-list the app
publishes into the shop metafield `cellexia.plan_groups` on every plan sync
(and again on go-live) — a group has to clear both to be rendered, so an
allow-list that has been hand-edited or corrupted into naming the other app's
group still renders nothing. Consequences worth knowing:

- If a product page shows no Cellexia widget where you expect one, the
  allow-list is missing or stale: **re-sync the plan from the Plans page**
  (that is what republishes it; going live republishes it too). The widget
  never guesses — there is no name matching and no "first group on the
  product" fallback, so an unpublished allow-list means no widget rather than
  a widget selling someone else's plan.
- Where both apps' plans sit on the same product, the page can show two
  subscribe widgets — ours and theirs. Cellexia cannot switch theirs off; do
  that in the other app before you go live.

**The id-space lesson (why ownership matches on PLAN ids).** Storefront
Liquid exposes selling plan **group** ids in a **different id space** than the
Admin API: the `selling_plan_group.id` a theme sees is an opaque storefront
identifier, not the numeric admin id the app records at sync time and
publishes into the allow-list — so a group-id comparison in Liquid can never
match, and a widget relying on it treats our own correctly-synced group as
foreign and renders nothing (on the live store this surfaced as the "plans
from another app" admin card on a product whose Cellexia sync had succeeded).
Individual selling **plan** ids ARE numeric and identical in both APIs (they
are what the cart's `selling_plan` parameter carries), so the buy box decides
ownership on plan ids: a group is ours iff it contains one of the
allow-list's `planIds`, with the group-id check kept only as a harmless
secondary OR. Anything that compares storefront-observed ids against
admin-recorded ones must use plan ids, never group ids; group-id equality is
reliable only admin-to-admin, which is exactly where the app verifies
attachment (below).

**Drift: the plan silently disappears from a product.** The other app's own
product sync can **detach our selling plan group** from products it also
manages while reconciling them — the config row still says synced, but the
product page has nothing of ours to render. Two guards close this:

- **Post-sync verification** — after every sync the app re-reads each
  product's selling plan groups from the Admin API and only reports
  **Synced** when the group is attached to *every* product in the plan.
  Anything less shows an **Attach failed** badge on the Plans row, naming the
  missing products.
- **Daily drift check** (`PLAN_GROUP_DRIFT`, part of the alert scan) —
  re-verifies every synced plan once a day and raises a WARNING alert ("Your
  Cellexia plan was detached from …") when a group has been detached after
  the fact.

Remediation, both cases: **re-sync the plan on the Plans page** (that
re-attaches the products and republishes the allow-list), then **exclude
those products from the other app's management** so its next sync does not
detach them again. If the badge or alert keeps returning for the same
products, the other app is still reconciling them — the exclusion, not the
re-sync, is the durable fix.

**Support actions.** Opening a `FOREIGN` or `UNKNOWN` subscriber shows the
cockpit with a banner, and every action on it (pause, resume, cancel, charge
now, retry, edit items, change the date, card-update email, portal link) is
refused server-side. Claim it, or take it over properly, first.

**App-proxy subpath (`/apps/cellexia-subs`).** The portal's store-domain path
is the `[app_proxy]` subpath in `shopify.app.toml`, mirrored by
`PORTAL_PROXY_SUBPATH` in `app/lib/portal/proxy-path.ts` and hardcoded in the
theme-extension JS (`buy-box.js` / `buy-box-embed.js`, which cannot import app
modules) — `tests/proxy-subpath.test.ts` keeps all four in agreement. The value
is `cellexia-subs`, **never** `cellexia`: the store's other live app ("AOV &
LTV Booster") already serves `/apps/cellexia`, and shipping on that subpath
handed portal traffic to the wrong app more than once. The Preview & launch
checklist row **"Portal proxy answers as Cellexia"** probes the live path
end-to-end (a signed preview-validate round trip on the store domain) and
fails whenever anything else answers there — another app occupying the path,
or an `[app_proxy]` config that was never deployed.

Changing the subpath is a **deploy-gated, customer-visible** change: the proxy
config only takes effect after `npm run deploy`, and the change **invalidates
every customer-bookmarked portal link** (the old `/apps/...` URL stops being
ours) as well as existing portal-session cookies, which are scoped to the old
path — customers simply log in again at the new URL. **Magic links are
unaffected**: they ride the app host (`SHOPIFY_APP_URL/magic/...`), not the
store domain.

## 19. Analytics — the cost model, and what the numbers mean

<a name="19-analytics"></a>

Everything on the Analytics page is derived data, recomputed by jobs
(`rollup_run` / `cohort_run` / `risk_learning_run` / `churn_risk_run` /
`retention_90d_run` / `origin_order_backfill` daily, `alerts_run` every 15
minutes — all keep running in Setup mode). Nothing here
changes billing; it is reporting only. Another app's subscribers and the demo
portal contract are excluded from every number.

### Where costs are set (required for LTGP to be real)

Gross profit and LTGP subtract three kinds of cost from collected revenue.
They are configured in exactly two places:

- **Settings → Costs & profit** (`costModel` setting): payment fee (% + fixed
  per charge — defaults to Shopify Payments CH Basic, 2.9% + 30¢; set your
  real plan's rate), fulfillment cost per shipment (pick/pack/packaging),
  shipping cost per shipment (flat per parcel, or "same as charged to the
  customer" — only sensible when shipping is passed through at cost; with free
  shipping use flat), and the **COGS fallback (% of price)** used only for
  products with no known cost (default 25%).
- **Plans → Costs & margins**: per-product COGS (cost per unit). Each row
  shows a badge for where the effective cost comes from — **Shopify cost**
  (the variant's "Cost per item", synced onto billed lines), **Override**
  (entered on this page), or **Estimated N%** (the fallback).

**Resolution order per billed line** (first known value wins): synced Shopify
cost → the override from the Plans page (variant-level, then product-level) →
the percentage-of-price estimate.

**What "estimated" means.** Every centime of COGS that came from the
percentage fallback is tracked separately. When any currently-billed product
has no known cost, the Cohorts & LTGP tab shows a warning banner ("LTGP is
partly estimated — N products missing costs") with the share of lines and of
revenue that have a known cost, and names the missing products; the same
condition (below 80% line coverage) raises a dashboard insight. The fix is
listed right in the banner: set costs on the Plans page, or as "Cost per item"
on the product in Shopify. When coverage is complete the banner disappears and
LTGP is real, not modelled.

### The LTGP formula, in one line

> **LTGP per subscriber** = payments actually collected (the first checkout
> payment where captured, plus every renewal, net of refunds) − product COGS
> (including gift COGS) − merchant-side fulfillment & shipping − payment
> processing fees, accumulated month by month for each signup cohort and
> divided by cohort size.

Notes that matter when reading it:

- **First orders included (v1.5.0).** The first (checkout) payment is not
  billed through the app, so it is mirrored from the order at contract
  creation and included in month 0. Older contracts are filled in by the
  daily `origin_order_backfill` job (200 per run, oldest first) — a freshly
  upgraded book reads slightly low until it completes, and contracts with no
  origin order (imports) contribute renewals only. First-order COGS is
  approximated from the subscription's current items. **If you watched
  these numbers before v1.5.0, expect cohort month-0 and every LTGP figure
  built on it to jump at the upgrade** — that is the first payment finally
  being counted (pre-1.5.0 revenue was structurally renewals-only), not a
  data error. Re-baseline payback comparisons once; the "renewals-only"
  qualifiers that used to hedge these screens are gone because the hedge no
  longer applies.
- **Discounts are not subtracted** — collected amounts are already net of
  every discount. The discount column is informational.
- **Customer-paid delivery is revenue**, not a cost; the shipping cost
  subtracted is what *you* pay per parcel (Settings → Costs & profit).
- Early months can read **negative**: a cohort's month 0 can carry gift COGS
  before any renewal has been billed. That is honest accounting, not a bug.

### Reading the cohort heatmap (Analytics → Cohorts & LTGP)

Rows are signup-month cohorts (newest 12); columns M0…M12 are months since
first charge; the current calendar month is marked "in progress". Three
measures via the selector:

- **Retention %** — share of the cohort still active N months in. Read *down*
  a column to compare cohorts at the same age (is retention improving
  cohort-over-cohort?); read *along* a row to see where one cohort's cliff is.
- **LTGP per subscriber** — cumulative gross profit ÷ cohort size (first
  orders included where captured — see the caveat above). This is the number
  to price acquisition against.
- **Cumulative LTGP** — the cohort's total money so far.

Hover any cell for the plain-English sentence. Color intensity is absolute
for retention (0–100%) and normalized to the largest value in view for the
money measures; negative cells are flagged.

### Predicted LTGP — the forward-looking overlay (v1.21.0)

Beside the cohort *actuals*, Analytics → Cohorts & LTGP shows **predicted
LTGP**: expected cumulative gross profit per subscriber at **90 days / 180
days / 1 / 3 / 5 years from signup**, recomputed nightly for every active
subscription and shown per subscriber on their cockpit page.

> **Predicted LTGP** = the store's censoring-corrected retention curve,
> conditioned on the cycles the subscriber has already reached and tilted by
> their churn-risk score (survey answers included), × their current
> per-cycle gross profit through the exact same cost model as the actuals —
> COGS, shipping, fees, VAT, and the refund-exclusion setting applied as a
> disclosed expected-refund haircut.

How to read it honestly:

- **Every horizon carries a grade (A–D)** capped by how much calendar
  history the store actually has relative to that horizon. A 5-year number
  on a young store grades D — *directional only* — by construction. Grades
  climb on their own as the store ages; nothing to configure.
- **The model grades its own homework.** Each subscriber scored within
  their first 8 days gets that day-one prediction frozen forever; once
  their 90-day (then 180-day, then 1-year) window has fully elapsed, the
  nightly job compares prediction to what actually happened and shows the
  measured error on the card. Until the first cohorts mature, the card
  says so instead of claiming accuracy.
- **Interventions don't fool it.** Survey-triggered flows must exclude the
  holdout slice (`survey_holdout` property, Settings → Post-purchase
  survey) — that untreated comparison group is what keeps the measured
  churn per answer segment (and therefore these predictions) honest.
- **Partly estimated costs flag through**: where COGS falls back to the
  percentage estimate or VAT is rate-derived, the prediction is marked
  estimated, exactly like the actuals' banner.
- Predictions live on the contract row (`predictedLtgp`), recomputed
  nightly by `predicted_ltgp_run`; PAUSED contracts keep their last value
  (billing is stopped — extrapolating a paused clock would be fiction) and
  its timestamp shows the staleness.

### The post-purchase survey — where the day-one signal comes from (v1.21.0)

Four one-tap questions on the order confirmation page (subscription orders
only): planned duration, motive, expected result speed, current routine.
Answers attach to the subscription, appear on the subscriber page, feed the
risk score and predicted LTGP, and fire the `Cellexia Survey Answered`
Klaviyo metric for answer-routed onboarding flows
([docs/KLAVIYO_SETUP.md](KLAVIYO_SETUP.md) §3.12). Three rules keep the
data trustworthy:

- **The instrument is frozen.** Question and option KEYS are versioned
  (`questionSetVersion`); wording lives in the extension's locale files,
  but changing an option's meaning requires a version bump — coefficients
  are estimated per option key over months of matured labels, and pooling
  two instruments corrupts both silently.
- **Skipping is a signal.** Shown-but-unanswered is stored and feeds the
  risk score (silence at checkout predicts silence at renewal); don't
  chase completion with incentives — a discount for answering attracts
  careless taps and trains deal-seeking in the exact people being scored.
- **Never message the holdout.** Every survey-triggered flow filters
  `survey_holdout equals false`. Changing the holdout percentage only
  affects future subscribers; assigned flags are never reshuffled.

### The forecast tab — models and trust

Five models compete: **naive** (last value carried forward), **damped trend**
(Holt smoothing that converges instead of extrapolating forever), **seasonal**
(week-of-month pattern; refuses to run below 16 weeks of history), **cohort
build-up** (your current base decayed by the measured per-cycle survival,
plus the recent new-subscriber run rate), and — since v1.5.0 — **blend**, an
average of the other models weighted by how accurate each has actually been
in the recorded weeks. **Auto** picks the winner: each night the models are
backtested against what really happened and every completed week's per-model
error is recorded (the note under the controls shows how many weeks are on
record); Auto weighs recent recorded weeks more — so one lucky week cannot
flip the choice, and the selection keeps calibrating itself to your store.
Before any weeks are recorded it falls back to the current walk-forward
backtest alone. The backtest table at the bottom shows each model's error
and bias ("runs high/low"). The shaded band is the ~80% likely range — it
widens with horizon and with a worse grade.

The **accuracy grade** is the honesty signal, shown wherever a projection is:

| Grade | Label | Driven by |
|---|---|---|
| A | High confidence | ≥26 weeks of history, and the backtest has been accurate |
| B | Moderate confidence | 12–25 weeks, or a solid history dented by error/noise |
| C | Low confidence | 6–11 weeks of history — no full quarter seen yet |
| D | Very low confidence — directional only | <6 weeks of history |

Within the history cap the grade moves down for a small active base (<30 —
small-number noise), backtest error >25%, or week-over-week swings >15%, and
up (never above the cap) when backtest error is <10%. Every input that moved
the grade is listed as a plain sentence in the "How much to trust this" card —
read those, not just the letter. Weeks with no rollup data are filled by
carrying the last value forward and are disclosed on the chart.

### The self-learning risk model — and why there are no knobs

Churn-risk scores (the at-risk list, predicted empty dates, win-back timing)
start from a hand-tuned **heuristic**. Since v1.5.0 the nightly
`risk_learning_run` job also trains a statistical model on your own history
(snapshots of every subscriber's signals, labeled by whether they churned in
the following 60 days) and evaluates it against the heuristic on held-out
data. The lifecycle is **heuristic → shadow → promoted**:

- **Heuristic**: scoring uses the hand-tuned rules. The learned model may
  already be training, but it influences nothing.
- **Shadow**: the learned model is trained and evaluated every night but
  still influences nothing — it stays in shadow until it has at least 50
  churned and 50 retained outcomes to learn from **and** provably beats the
  heuristic on held-out data by a real margin.
- **Promoted**: the learned model scores. If a later evaluation shows it no
  longer qualifies (data drift, a changed store), it is demoted back to
  shadow the same way — silently and safely.

**Where to see it**: the chip on the Analytics **Overview** tab. It reads
either "Heuristic — learns automatically once ~N churn outcomes exist (M
decided so far)" or "Learned model, AUC …, trained on N outcomes". The chip
never claims "learned" without the sample counts to prove it, and every
nightly training decision — including promotions and demotions, with the
evaluation numbers behind them — is logged to the Audit page as an
`admin.action` event (`action: "risk_model_trained"`).

**What to do about it: nothing.** There is no setting to enable, no
threshold to tune, and deliberately no way to force a promotion — the model
promotes itself exactly when it is provably better on your data and not one
day earlier. The same applies to the forecast's model choice above: leave it
on Auto. The one thing that genuinely improves both systems is accurate
inputs — real costs (see above) and time: more subscribers and more decided
outcomes make the models measurably better, on their own.

### Acquisition data on the subscriber page

Since v1.5.0 every new subscription captures a sanitized snapshot of **where
the subscriber came from**: referring/landing site, Shopify channel, UTM
parameters, country/city/province, device class (mobile/desktop/tablet),
account-age-to-first-order time, and first-order size/value band. Full
field-by-field reference, sanitization rules and future uses:
[DATA_FOUNDATION.md](./DATA_FOUNDATION.md).

- **Where to see it**: the **Acquisition** card on the subscriber detail
  page (Subscribers → open a subscriber), and in Klaviyo as the profile
  attributes `cellexia_acq_source` / `cellexia_acq_country` (for
  segmentation). Historical/imported subscribers without an origin order
  show no card — the data is only recorded when it truly existed.
- **Privacy is structural, not policy**: the sanitizer strips every
  non-`utm_*` query parameter, never stores an IP or a full user-agent, and
  caps every field. A GDPR `customers/redact` erases all of it (§11).
- **Why collect it now**: none of the channel-level reports exist yet — the
  point is that when they are built (source-level LTGP, geo cohorts, device
  take-rate), the history will already be there instead of starting cold.

### Insights

The dashboard and Overview tab surface at most five plain-language cards, each
stating its evidence: churn spikes vs the 4-week baseline, dunning recovery vs
the 55–70% band, save rate vs the 20–30% band, missing product costs, take-rate
moves >2 points week-over-week, a deteriorating skip:cancel ratio, and
"forecasts are still calibrating" while history is short. Rules stay silent
below minimum sample sizes — no insight is better than a noisy one. For the
weekly review routine and targets, see
[OFFER_PLAYBOOK.md — Reading your analytics](./OFFER_PLAYBOOK.md#reading-your-analytics).

### Trivia worth knowing

- **Take rate** needs the storefront checkout counter; until those events
  flow, the card shows "—", not zero. Days recorded before v1.4.0 counted
  renewal orders in the denominator and read lower; imports can push the rate
  above 100% (the numerator counts contracts by real arrival date).
- **Rollups self-heal**: an outage leaves no permanent holes — missing days
  are backfilled (up to 90 days) from raw data, and the last 2 closed days are
  recomputed every run so late-settling charges land in their true day. Failed
  daily jobs retry within 30 minutes.
- **Survival curves** wait for at least 10 subscribers to have either churned
  or renewed — below that the page says "too early to measure" instead of
  drawing noise.

## 20. Runbook — widget not showing?

<a name="20-runbook--widget-not-showing"></a>

**Run the Preview Doctor.** Preview & launch → Storefront preview → **Preview
Doctor** → pick the product → **Run diagnosis**. Everything else in this
section is what to do with its answer — do not start bisecting by hand.

The widget only appears when ~7 independent gates are all open, and every
closed gate produces the identical symptom: a blank product page. The doctor
walks the chain **in order, against the live store** (nothing is cached, and
nothing on the store is changed) and names the first closed gate:

1. **Subscription plan synced** — a plan exists, is active, `SYNCED`, with a
   Shopify group **and** selling plan ids recorded.
2. **Product is part of the plan** — the diagnosed product is in the plan's
   product list.
3. **Shopify shows the plan on this product** — the selling plan group is
   actually attached (Admin API read-back, same check as §14 in
   [INSTALL.md §10](./INSTALL.md#10-preview-then-go-live) drift terms).
4. **Storefront allow-list published** — `cellexia.plan_groups` exists and
   carries our group id **and our plan ids** (the storefront matches
   ownership on plan ids; a list with group ids but no plan ids renders
   nothing — that exact shape is a FAIL here).
5. **App proxy answers as Cellexia** — the live
   `/apps/cellexia-subs/preview/validate` probe; HTTP 404 means the app
   configuration was never deployed (`npm run deploy`), a foreign body means
   another app owns the path.
6. **Widget markup reaches the live product page** — the doctor fetches the
   real PDP HTML and looks for our markers; missing markers mean the
   extension is not deployed or the app embed is off on the published theme
   (§16).
7. **Launch mode** — informational: SETUP means hidden-until-previewed by
   design.

Each step reports **Pass / Fail / Check / Skipped** with a detail line and the
fix. Start at the **first Fail**, apply its fix, re-run. **Check** (WARN)
means the probe was inconclusive — storefront password page, bot protection,
or a network hiccup between app host and store — open the page in your own
browser instead of treating it as broken. Every run is recorded on the Audit
page as `admin.action` / `preview_doctor_run`.

You usually do not need to run it by hand first: **Preview on product page
runs the same diagnosis automatically** and, when a gate is closed, shows the
report instead of opening the blank tab (with an **Open anyway** escape
hatch). A doctor that cannot run at all never blocks the preview — it fails
open, and says so: the preview opens with a toast that the pre-flight
diagnosis was skipped (run **Run diagnosis** by hand if that page looks
blank), and the `storefront_preview_created` audit event carries
`doctorSkipped: true`. Only a doctor-vetted open ticks the **Storefront
previewed** checklist item: **Open anyway** and the fail-open path open the
tab but leave the item unticked (the audit event carries
`checklistPreviewedStorefront: false`) — preview again once the diagnosis
passes to tick it.
