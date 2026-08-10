# Klaviyo Setup — Cellexia Subscriptions

The app pushes every customer-facing subscription moment to Klaviyo as a
server-side event (via a durable outbox — nothing is lost if Klaviyo is briefly
down). **Klaviyo flows own delivery, branding, timing and consent**; the app
supplies the metrics, the properties, and — crucially — signed one-tap
**magic-link URLs** so every email/SMS can carry "Skip", "Delay", "Update card"
buttons that work with zero login.

Direct SMTP is used only for mail that must never depend on Klaviyo:
OTP login codes, 3DS action requests, admin alerts and import summaries.

---

## 1. Private API key + environment

1. In Klaviyo: **Account → Settings → API keys → Create Private API Key**.
2. Name it `Cellexia Subscriptions (server)`. Grant scope **Events: Full**
   (custom-scoped keys are recommended over Full Access keys).
3. Copy the `pk_...` value — it is shown once.
4. Set the environment variables on the app host:

```bash
KLAVIYO_PRIVATE_API_KEY=pk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
KLAVIYO_API_REVISION=2024-10-15     # Events API revision date (optional; this is the default)
```

Until the key is set, events accumulate in the `KlaviyoOutbox` table with
status `PENDING` and flush automatically once the key appears — you lose
nothing by configuring Klaviyo after launch.

Delivery mechanics (for the curious): the `klaviyo_flush` job drains the
outbox every tick; retryable failures (Klaviyo 5xx, network, 429) back off
exponentially (2^attempts minutes, capped at 6 h, max 10 attempts), permanent
4xx failures are dead-lettered with the error stored on the row.

---

## 2. Metric catalog

All metrics are prefixed `Cellexia ` so they group together in Klaviyo.
Every contract-scoped event also carries the **standard snapshot properties**
(section 2.1) on top of the per-metric properties listed here.

### State-change metrics (fired automatically by the event log)

| Metric | Fired when | Key properties |
|---|---|---|
| `Cellexia Subscription Started` | New contract created (checkout or import) | snapshot |
| `Cellexia Subscription Cancelled` | Contract cancelled (any source) | snapshot, `cancelReason`* |
| `Cellexia Subscription Paused` | Contract paused | snapshot, `resumeAt`* |
| `Cellexia Subscription Resumed` | Contract resumed | snapshot |
| `Cellexia Order Skipped` | Next cycle skipped | snapshot, `cycleIndex`* |
| `Cellexia Order Unskipped` | Skip reversed | snapshot, `cycleIndex`* |
| `Cellexia Order Delayed` | Next order pushed out | snapshot, `weeks`* |
| `Cellexia Frequency Changed` | Delivery interval changed | snapshot, `oldUnit`/`oldCount`/`newUnit`/`newCount` (exact interval), `oldWeeks`/`newWeeks` (whole-week approximation, retained for existing flows)* |
| `Cellexia Product Swapped` | Line variant swapped | snapshot, old/new variant* |
| `Cellexia Add-on Added` | One-time add-on attached to next order | snapshot, `variantId`* |
| `Cellexia Payment Failed` | A billing attempt failed (also fired by the dunning ladder notifications) | snapshot, `attempt_number`, `amount_cents`, `amount_formatted`, `decline_code`, `decline_category`, `dunning_state`, `dunning_ladder_step`, `next_retry_at`, `card_brand`, `card_last4`, `card_expiry`, **magic links** |
| `Cellexia Payment Recovered` | Dunning case recovered | snapshot |
| `Cellexia Card Expiring` | Pre-expiry notice (default 30 days out) | snapshot, `card_brand`, `card_last4`, `card_expiry`, **magic links** |
| `Cellexia 3DS Action Required` | Bank requires authentication for a renewal | snapshot, `threeds_url` (bank challenge URL), **magic links** |
| `Cellexia Cancel Save Accepted` | Customer accepted a save offer in the cancel flow | snapshot, offer details* |
| `Cellexia Final Offer Accepted` | Customer accepted the last-chance offer | snapshot, offer details* |
| `Cellexia Winback Soft Touch` | Win-back stage 0 (education, no offer) | snapshot |
| `Cellexia Winback Perk` | Win-back stage 1 (free gift perk) | snapshot, perk details* |
| `Cellexia Winback Discount` | Win-back stage 2 (capped discount) | snapshot, `percent`* |
| `Cellexia Winback Reactivated` | Cancelled subscriber came back | snapshot |
| `Cellexia Milestone Reached` | Milestone gift / anniversary reached | snapshot, milestone details* |
| `Cellexia Rewards Unlocked` | Rewards tier unlocked (default day 90) | snapshot |
| `Cellexia Gift Scheduled` | A free gift is scheduled for an upcoming order | snapshot, `variantId`* |
| `Cellexia Incentive Announced` | Early-cycle incentive announced (orders 1–2) | snapshot, incentive details* |
| `Cellexia Price Change Notice` | Price change applied/announced to a contract | snapshot, old/new price* |
| `Cellexia Stockout Delay` | Renewal delayed because an item is out of stock | snapshot, `delayDays`* |

\* = passed through from the internal event payload; exact keys depend on the
emitting module. Build flows against the snapshot + the explicitly named
properties; treat the rest as bonus context.

### Notification-trigger metrics (fired by the notifications router)

| Metric | Fired when | Key properties |
|---|---|---|
| `Cellexia Upcoming Order` | N days before each renewal (default 3, setting `notifications.upcomingOrderDaysBefore`), once per cycle | snapshot, `cycleIndex`, **magic links** incl. `addon_url`, plus the **add-on suggestion properties** (`addon_variant_id`, `addon_product_id`, `addon_title`, `addon_price_cents`, `addon_price_formatted`, `addon_image_url`) when a suggestion is attached — see 2.2 |
| `Cellexia Order Confirmed` | Renewal charged successfully | snapshot, order name/amount |
| `Cellexia Order Shipped` | Fulfillment shipped | snapshot, tracking vars |
| `Cellexia Resume Reminder` | A few days before a paused subscription auto-resumes | snapshot, **magic links** |
| `Cellexia Quantity Changed` | Line quantity changed | snapshot |
| `Cellexia Address Updated` | Delivery address changed | snapshot |
| `Cellexia Payment Method Updated` | Card updated | snapshot |
| `Cellexia Stockout Skip` | Cycle skipped due to stockout | snapshot |
| `Cellexia Stockout Substitute` | Item substituted due to stockout | snapshot |

Deduplication: identical metric + profile + contract enqueued twice within
2 minutes collapses to one Klaviyo event, so the automatic state-change path
and an explicit confirmation notification never double-fire a flow.

`otp_code`, `admin_alert` and `import_summary` are **never** sent to Klaviyo.

### 2.1 Standard snapshot properties (every contract-scoped metric)

| Property | Example |
|---|---|
| `contract_id` | `clx1abc...` (app-internal ID — used by support) |
| `shopify_contract_id` | `gid://shopify/SubscriptionContract/123` |
| `contract_status` | `ACTIVE` |
| `interval_weeks` | `8` (whole-week approximation, retained for existing flows) |
| `interval_unit` | `MONTH` (`DAY` / `WEEK` / `MONTH` — v1.8.0) |
| `interval_count` | `2` — with `interval_unit`, the exact billing interval ("every 2 months") |
| `orders_count` | `4` |
| `currency` | `GBP` |
| `is_prepaid` | `false` |
| `item_titles` | `["Regenerating Night Serum"]` |
| `items` | `[{title, variant_title, quantity, is_gift, is_one_time_addon}]` |
| `next_billing_date` | `2026-08-12T00:00:00.000Z` |
| `next_billing_date_formatted` | `12 August 2026` (shop timezone, contract locale) |
| `portal_url` | `https://www.cellexia.com/apps/cellexia-subs/` |
| `event_type` | internal type, e.g. `cycle.skipped` (state-change metrics) |
| `template` | template key, e.g. `upcoming_order` (notification metrics) |

### 2.2 Magic-link properties (one-tap, zero-login)

Attached to: `Cellexia Upcoming Order`, `Cellexia Payment Failed`,
`Cellexia Card Expiring`, `Cellexia 3DS Action Required`,
`Cellexia Resume Reminder`, all `Cellexia Winback *` notification sends.

| Property | Action |
|---|---|
| `skip_url` | Skip the next order |
| `delay_1w_url` | Push the next order out 1 week |
| `delay_3w_url` | Push the next order out 3 weeks |
| `update_card_url` | Secure card-update page (multi-use, 5 uses) |
| `pause_url` | Pause for 1 month |
| `addon_url` | Add the suggested product to the next order (present only when a suggestion is attached) |

Links are signed, expire after 14 days (setting `portal.magicLinkTtlDays`) and
are single-use unless noted. **Always** pair them with `portal_url` as the
fallback "Manage subscription" link for when a link has expired.

**Add-on suggestion (`Cellexia Upcoming Order` only).** When the app attaches
an add-on suggestion, `addon_url` comes with companion properties for the
creative:

| Property | Meaning |
|---|---|
| `addon_variant_id` | Suggested variant GID (`gid://shopify/ProductVariant/…`) |
| `addon_product_id` | Suggested product GID |
| `addon_title` | Display title, e.g. `Firming Eye Cream (30ml)` |
| `addon_price_cents` / `addon_price_formatted` | Price at the ongoing subscription discount — exactly what the customer will be charged |
| `addon_image_url` | Product/variant image (may be absent) |

How the suggestion is chosen (all merchant-controlled):

- Master switch: setting `notifications.addonSuggestionEnabled` (Admin →
  Settings → Notifications). The suggestion is also suppressed while
  `portal.allowAddProducts` is off — the link is portal add-product with
  fewer taps.
- Setting `notifications.addonSuggestionVariantId` pins a specific variant
  (e.g. the current hero upsell). Left empty, the app auto-picks the
  top-listed subscribable product.
- Per customer, the app skips anything already in their box (subscription
  lines, gifts, staged add-ons) and falls back to the next candidate; if the
  customer already receives everything, no suggestion is attached — so
  **always** wrap the add-on block in `{% if event.addon_url %}`.

In a Klaviyo template, use them like any event variable:

```html
<a href="{{ event.skip_url }}">Skip this order</a>
<a href="{{ event.delay_3w_url }}">Delay 3 weeks</a>
<a href="{{ event.update_card_url }}">Update my card</a>
```

### 2.3 Profile properties (synced on every event — use for segments)

| Property | Meaning |
|---|---|
| `cellexia_subscription_status` | `ACTIVE` / `PAUSED` / `CANCELLED` / `FAILED` / `EXPIRED` |
| `cellexia_orders_count` | Successful cycles billed |
| `cellexia_interval_weeks` | Current delivery interval in weeks (whole-week approximation, retained for existing flows) |
| `cellexia_interval_unit` / `cellexia_interval_count` | Exact delivery interval — `DAY`/`WEEK`/`MONTH` + count (v1.8.0) |
| `cellexia_next_billing_date` | ISO datetime of next renewal |
| `cellexia_churn_risk` | 0–1 churn-risk score from the analytics engine |
| `cellexia_dunning_open` | `true` while a payment failure is unresolved |

---

## 3. Flow recipes

Create each flow in Klaviyo (**Flows → Create flow → Build your own**) with the
trigger/filters/timing below. All customer flows should have "Smart Sending"
OFF for transactional-style messages (upcoming order, dunning, 3DS) so they are
never suppressed, and ON for marketing-style touches (win-back, onboarding).

### 3.1 Upcoming Order Reminder

- **Trigger:** metric `Cellexia Upcoming Order`
- **Timing:** send immediately (the app already fires it N days pre-renewal;
  merchant-configurable via the `notifications.upcomingOrderDaysBefore` setting)
- **Content:** date (`{{ event.next_billing_date_formatted }}`), items
  (`{{ event.item_titles }}`), and three buttons:
  `{{ event.skip_url }}` ("Skip this one"), `{{ event.delay_3w_url }}`
  ("I have plenty — delay 3 weeks"), `{{ event.addon_url }}` ("Add
  {{ event.addon_title }} for {{ event.addon_price_formatted }}" — one tap,
  charged with this renewal only; wrap the whole block in
  `{% if event.addon_url %}` and use `{{ event.addon_image_url }}` for the
  product shot)
- **Why it matters:** a friction-free skip beats a cancellation every time —
  and the add-on button is the cheapest AOV lift in the app.

### 3.2 Dunning ladder (payment recovery)

- **Trigger:** metric `Cellexia Payment Failed`
- **Flow filter:** `cellexia_dunning_open` is true; exit the flow when
  `Cellexia Payment Recovered` or `Cellexia Subscription Cancelled` occurs
  since starting the flow.
- **Structure — conditional split on `event.attempt_number`:**
  - `attempt_number = 1` → **Email, immediately** ("Hiccup with your payment —
    your routine is safe"): soft tone, `{{ event.update_card_url }}` button,
    mention `{{ event.card_brand }} ···{{ event.card_last4 }}`.
  - `attempt_number = 2` (app retries ~day 3) → **Email, immediately**:
    clearer urgency, same `update_card_url` button.
  - `attempt_number = 3` (~day 7) → **Email, immediately**: "last email before
    we pause your subscription", `update_card_url` + `pause_url` as an
    off-ramp.
  - **SMS at day 8:** separate branch — after the attempt 3 email, time-delay
    1 day, then SMS **with a filter "profile is consented to SMS"**:
    `Cellexia: we still can't process your payment. Fix it in 10 seconds:
    {{ event.update_card_url }}`.
- The app's retry schedule (default days 0/3/7/14, payday-aligned) is the
  source of truth for *charging*; this flow is the *messaging* mirror of it.
  If you change the `dunning` setting ladder, mirror the timing here.

### 3.3 Card Expiring (pre-dunning)

- **Trigger:** metric `Cellexia Card Expiring` (app fires it ~30 days before
  the card on file expires — setting `dunning.preExpiryNoticeDays`)
- **Timing:** email immediately; optional reminder email after 14 days with
  flow filter "has not had `Cellexia Payment Method Updated` since starting
  this flow".
- **Content:** `{{ event.card_brand }} ···{{ event.card_last4 }}` expiring
  `{{ event.card_expiry }}`, one button: `{{ event.update_card_url }}`.

### 3.4 3DS Action Required

- **Trigger:** metric `Cellexia 3DS Action Required`
- **Timing:** immediately. No smart sending, no quiet hours — this is blocking
  a charge the customer wants to happen.
- **Content:** single prominent button to `{{ event.threeds_url }}`
  ("Confirm with your bank"). Note the app *also* sends a direct
  transactional email for this event, so keep this flow short.

### 3.5 Onboarding — weeks 1–2 education (new subscribers)

- **Trigger:** metric `Cellexia Subscription Started`
- **Flow filter:** `event.orders_count = 0` (skips imported/migrated
  subscribers who already have history)
- **Timing & content:**
  - Day 1: "How to get the most from your routine" (usage, expectations —
    anti-aging results take 4–6 weeks; sets up the "not seeing results"
    objection before it forms).
  - Day 5: texture/application tips + link to `{{ event.portal_url }}`
    ("your subscription, your rules — skip or delay anytime").
  - Day 12: social proof + before/after timeline ("what week 4 looks like").

### 3.6 Early-cycle incentive announcements (orders 1–2)

- **Trigger:** metric `Cellexia Incentive Announced` (fired by the lifecycle
  engine when `lifecycle.earlyCycleIncentivesEnabled` is on); the surprise-gift
  variant fires `Cellexia Gift Scheduled`.
- **Timing:** immediately.
- **Content:** "Stay subscribed — your next order includes a free X" using the
  event's gift/incentive properties. Filter `event.orders_count < 2` if you
  want to restrict strictly to the first two cycles.

### 3.7 Milestones + Rewards Unlocked (day 90)

- **Triggers:** metric `Cellexia Milestone Reached` (milestone gifts,
  anniversary) and metric `Cellexia Rewards Unlocked` (fires at day 90 by
  default — setting `lifecycle.rewardsUnlockDay`).
- **Timing:** immediately.
- **Content:** celebrate tenure ("90 days of consistency — skin loves
  routine"), present the unlocked perk, CTA to `{{ event.portal_url }}`.

### 3.8 Win-back series (cancelled subscribers)

Three separate single-email flows — the app owns the *timing* (staged against
each customer's predicted product-empty date, not the cancel date), Klaviyo
owns the content:

- **Trigger `Cellexia Winback Soft Touch`:** helpful, no offer. "How's your
  skin doing without it?" + routine tips. Buttons: `{{ event.portal_url }}`.
- **Trigger `Cellexia Winback Perk`:** free-gift offer to restart.
- **Trigger `Cellexia Winback Discount`:** capped discount (percent in event
  properties), clearly framed as final.
- **Exit condition on all three:** `Cellexia Winback Reactivated` or
  `Cellexia Subscription Started` since entering the flow.
- Optional: a "welcome back" email triggered by `Cellexia Winback Reactivated`.

### 3.9 Cancel-save follow-up

- **Trigger:** metric `Cellexia Cancel Save Accepted` (and a parallel flow on
  `Cellexia Final Offer Accepted`)
- **Timing:** immediately, then a check-in email after 2 weeks.
- **Content:** confirm exactly what changed (skipped / slowed down / paused /
  discount applied — use the offer properties), reassure, and remind them of
  `{{ event.portal_url }}`. The 2-week check-in protects the save from
  becoming a delayed cancellation.

### 3.10 Price change notice

- **Trigger:** metric `Cellexia Price Change Notice`
- **Timing:** immediately (the app fires it per its notice window — setting
  `priceChangePolicy.noticeDays`, default 30 days before the new price bills).
- **Content:** old/new price from event properties, effective date, and honest
  framing; include `{{ event.portal_url }}` so the choice to adjust or cancel
  is one tap away. Transparency here measurably reduces involuntary-feeling
  churn later.

### 3.11 Text-to-skip — SMS keyword "SKIP"

Let SMS subscribers skip their next order by replying `SKIP`:

1. In Klaviyo: **Settings → SMS → Keywords → Add keyword** → `SKIP`
   (add variants `SKIP NEXT`, `SAUTER` etc. as needed).
2. Create a flow: **Trigger: someone sends the keyword `SKIP`**.
3. Add a **Webhook** action:
   - **URL:** `{APP_URL}/api/sms/inbound` (your app host, e.g.
     `https://subscriptions.cellexia.com/api/sms/inbound`)
   - **Method:** POST, **Content-type:** `application/json`
   - **Header:** `x-cellexia-sms-secret: {SMS_INBOUND_SECRET}` — the same
     value as the app's `SMS_INBOUND_SECRET` environment variable. Requests
     without it are rejected.
   - **Body (property mapping):**

     ```json
     {
       "keyword": "SKIP",
       "phone": "{{ person.phone_number }}"
     }
     ```

4. After the webhook action, add an SMS confirmation:
   `Done — we've skipped your next Cellexia order. Reply HELP for options.`

The endpoint (provided by the magic-links module) looks up the active contract
by phone number and skips the next cycle, logging `cycle.skipped` — which in
turn fires `Cellexia Order Skipped` back into Klaviyo for your records.

---

## 4. Segments

With the synced profile properties (section 2.3) these are one-condition
segments:

| Segment | Definition |
|---|---|
| **Cellexia — Active Subscribers** | `cellexia_subscription_status` equals `ACTIVE` |
| **Cellexia — At-risk** | `cellexia_subscription_status` equals `ACTIVE` AND `cellexia_churn_risk` is at least `0.6` |
| **Cellexia — Dunning open** | `cellexia_dunning_open` equals `true` |
| **Cellexia — Cancelled (win-back pool)** | `cellexia_subscription_status` equals `CANCELLED` AND what someone has done: `Cellexia Winback Reactivated` zero times over all time |

Use "Active Subscribers" to *exclude* subscribers from acquisition campaigns
(don't discount people who already pay full price) and to power
subscriber-only content. Use "At-risk" for a gentle concierge campaign, never
for pre-emptive discounts.

---

## 5. Appendix — template variable reference

Variables available in Klaviyo templates via `{{ event.* }}`:

| Variable | Available on | Notes |
|---|---|---|
| `contract_id`, `shopify_contract_id` | all contract metrics | for support deep links |
| `contract_status` | all contract metrics | `ACTIVE`, `PAUSED`, ... |
| `interval_weeks`, `orders_count`, `currency`, `is_prepaid` | all contract metrics | `interval_weeks` is a whole-week approximation, retained for existing flows |
| `interval_unit`, `interval_count` | all contract metrics | exact billing interval — `DAY`/`WEEK`/`MONTH` + count (v1.8.0) |
| `item_titles` | all contract metrics | array — loop or join |
| `items` | all contract metrics | array of `{title, variant_title, quantity, is_gift, is_one_time_addon}` |
| `next_billing_date`, `next_billing_date_formatted` | all contract metrics | formatted = shop timezone + locale |
| `portal_url` | all contract metrics | always include as fallback CTA |
| `skip_url`, `delay_1w_url`, `delay_3w_url`, `update_card_url`, `pause_url`, `addon_url` | link-bundle metrics (2.2) | signed, expiring; `addon_url` conditional |
| `addon_variant_id`, `addon_product_id`, `addon_title`, `addon_price_cents`, `addon_price_formatted`, `addon_image_url` | Upcoming Order | present only alongside `addon_url` (see 2.2); price is at the ongoing subscription discount |
| `attempt_number` | Payment Failed | 1-based; drives the dunning splits |
| `amount_cents`, `amount_formatted` | Payment Failed | `amount_formatted` is locale/currency aware |
| `decline_code`, `decline_category` | Payment Failed | category: `SOFT` / `HARD` / `AUTH_REQUIRED` |
| `dunning_state`, `dunning_ladder_step`, `next_retry_at` | Payment Failed | |
| `card_brand`, `card_last4`, `card_expiry` | Payment Failed, Card Expiring | e.g. `visa`, `4242`, `09/2026` |
| `threeds_url` | 3DS Action Required | the bank's challenge URL |
| `cycleIndex` | Upcoming Order + cycle metrics | used for once-per-cycle logic app-side |
| `frequency_weeks` | Upcoming Order, Resume Reminder | whole-week approximation, retained for existing flows |
| `frequency_unit`, `frequency_count`, `frequency` | Upcoming Order, Resume Reminder | exact cadence (`DAY`/`WEEK`/`MONTH` + count); `frequency` is the localized phrase ("every 2 months") in the contract locale (v1.8.0) |
| `oldUnit`, `oldCount`, `newUnit`, `newCount` | Frequency Changed | exact cadence before/after; `oldWeeks`/`newWeeks` remain the whole-week approximations |
| `event_type` / `template` | state-change / notification metrics | internal origin identifiers |

Direct-SMTP templates (OTP, 3DS, admin alert, import summary) render from the
app's i18n catalog at `email.{template}.subject` / `email.{template}.body`
(with `{cta}` button placement via `cta_url` / `cta_label` vars) — see
`app/lib/notifications/templates.server.ts`. They are intentionally plain:
Klaviyo remains the styling home for everything customers see routinely.
