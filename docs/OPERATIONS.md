# OPERATIONS — day-2 runbooks

Runbooks for operating Cellexia Subscriptions in production. Written for the
operator (CX lead / ops) with the developer on call.

Related: [INSTALL.md](./INSTALL.md), [UPDATE.md](./UPDATE.md),
[TESTING.md](./TESTING.md), [OFFER_PLAYBOOK.md](./OFFER_PLAYBOOK.md).

Everything below happens in the embedded admin (Shopify admin → Apps → Cellexia
Subscriptions) unless a shell command is shown.

---

## 1. Daily ops tour (5 minutes, every morning)

1. **Dashboard** — headline tiles: active subscribers, MRR, yesterday's charges,
   failed attempts, open dunning cases, skips vs cancels. Anything red links to
   its page.
2. **Alerts** — unresolved alerts (`BILLING_RUN_FAILED`, `WEBHOOK_FAILURES`,
   `STUCK_CONTRACTS`, `FAILURE_SPIKE`, `CHURN_SPIKE`, `FAST_SHIPPING_SKIPS`,
   `STOCKOUT_RENEWALS`). Triage per the runbooks below; resolve when handled.
   Critical alerts also email everyone in Settings → alerts → `emailTo`.
3. **Dunning** — open cases, sorted by next retry. Sanity-check the queue size
   against yesterday (see §5).
4. **Audit** — skim the event stream for anything unusual (bursts of
   `billing.attempt_failed`, `notification.failed`, webhook failures).
5. External: your uptime monitor on `/api/health` (§12) should be green.

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

Meaning: `WebhookReceipt` rows with status `FAILED` above threshold, or Partner
Dashboard shows delivery failures.

1. Audit page → filter webhook failures → read the stored `error` per receipt.
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
- Never retry a **HARD** decline manually (stolen/invalid card) — the engine
  won't either; the customer must update the card.

## 6. Issuing refunds

Refunds are a **Shopify admin** operation, not an app operation:

1. Shopify admin → Orders → the renewal order → **Refund**.
2. The app hears about it via order webhooks; analytics count refunds against
   revenue in the rollups. The subscription itself is untouched — cancel/pause
   separately if the customer is leaving (ideally through the cancel flow so a
   reason is recorded).
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
| `APP_SIGNING_SECRET` | **Invalidates every outstanding magic link, portal session and pending OTP immediately.** Links already sitting in customers' inboxes (skip links in upcoming-order emails, card-update links in dunning emails) will show "link expired". | Rotate only on suspicion of compromise or scheduled hygiene. Do it at a low-traffic hour: set the new value, restart. Then **send fresh links**: Bulk ops → re-send card-update links for all open dunning cases, and accept that pre-rotation upcoming-order emails will route customers to portal login (OTP) instead — that path always works. |
| `CRON_SECRET` | External cron gets 401s until updated. | Set new value on host **and** in the cron service in the same minute. Internal-scheduler installs: no urgency. |
| `SHOPIFY_API_SECRET` | Webhook HMACs + app-proxy signatures fail → webhooks rejected, portal 401s. | Rotate in the Partner Dashboard, update the host secret immediately, redeploy. Verify a webhook arrives and `/apps/cellexia` loads. |
| SMTP / Klaviyo keys | Notifications fail (contained — billing unaffected; Klaviyo events queue in the outbox and retry). | Update, restart, confirm the outbox drains and `notification.sent` events resume. |

## 11. GDPR requests

Shopify sends three mandatory webhooks; the app handles them automatically and
records receipts:

- `customers/data_request` → the app compiles what it holds (contract mirror,
  events, notification log) and raises an alert so the operator can attach it to
  the reply within the 30-day window. The formal response to the customer is
  yours to send.
- `customers/redact` → PII on that customer's rows is anonymised (email/phone/
  name/address), keeping anonymous rows for financial reporting.
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
for the original go-live; this section is the day-2 view.

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
that, so treat them as private). Portal preview sessions are shorter-lived
(the link is valid 1 hour; the session persists in that browser) and are
read-only by construction — every mutating action is intercepted.

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
Also re-run the app-embed cart checks in
[TESTING.md §10](./TESTING.md#10-preview-based-qa-pre-launch-on-the-live-store)
after a redesign — the embed injects the selling plan into the theme's cart
requests, and a new theme means a new cart implementation.
