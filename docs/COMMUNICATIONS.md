# Communications — Klaviyo integration & outbox

Owner: `[communications]`. Files:

- `app/services/communications/klaviyo.server.ts` — Klaviyo Events API client,
  outbox delivery (`processOutboxJob`), `trackEventNow`, `klaviyoEnabled`.
- `app/services/communications/templates.server.ts` — `SUGGESTED_FLOWS`
  blueprint for every Klaviyo flow the merchant should build.
- `app/routes/app.settings.tsx` — admin UI (Integrations / Team & roles /
  Audit log / Data / General).

## How events reach Klaviyo

```
service code ──▶ emitLifecycleEvent()          [services/events.server.ts]
                   ├─ AnalyticsEvent row       (warehouse, always)
                   └─ OutboundEvent row        (only when an email is present)
                                 │
POST /jobs/outbox ──▶ processOutboxJob()       [this module]
                                 │
                                 ▼
                 POST https://a.klaviyo.com/api/events/
                 headers: revision: 2024-10-15
                          Authorization: Klaviyo-API-Key <decrypted key>
```

No module ever calls Klaviyo directly (hard convention #7). The single
exception surface is `trackEventNow(shop, {eventName, email, payload})` in this
module, reserved for time-critical sends (e.g. magic-link sign-in emails if the
outbox cadence is too slow for the 30-minute token window).

## Event → metric table

Metric names are produced by the pure `eventNameToMetric` function:
`"Cellexia " + Title Case(event name)`. All 25 lifecycle events:

| LifecycleEvent | Klaviyo metric |
| --- | --- |
| SUBSCRIPTION_STARTED | Cellexia Subscription Started |
| FIRST_CHARGE_APPROACHING | Cellexia First Charge Approaching |
| CHARGE_COMPLETED | Cellexia Charge Completed |
| CHARGE_FAILED | Cellexia Charge Failed |
| CARD_EXPIRING | Cellexia Card Expiring |
| SHIPMENT_DELAYED | Cellexia Shipment Delayed |
| PRODUCT_ADDED | Cellexia Product Added |
| PRODUCT_REMOVED | Cellexia Product Removed |
| ORDER_SKIPPED | Cellexia Order Skipped |
| PAUSE_STARTED | Cellexia Pause Started |
| PAUSE_ENDING | Cellexia Pause Ending |
| HIGH_CHURN_RISK | Cellexia High Churn Risk |
| LIKELY_EXCESS_INVENTORY | Cellexia Likely Excess Inventory |
| LIKELY_PRODUCT_SHORTAGE | Cellexia Likely Product Shortage |
| TREATMENT_MILESTONE | Cellexia Treatment Milestone |
| CANCELLATION_STARTED | Cellexia Cancellation Started |
| CANCELLATION_SAVED | Cellexia Cancellation Saved |
| CANCELLATION_COMPLETED | Cellexia Cancellation Completed |
| ELIGIBLE_FOR_UPGRADE | Cellexia Eligible For Upgrade |
| REPEATED_ONE_TIME_ADD_ON | Cellexia Repeated One Time Add On |
| PRODUCT_OUT_OF_STOCK | Cellexia Product Out Of Stock |
| PRODUCT_BACK_IN_STOCK | Cellexia Product Back In Stock |
| SUBSCRIBER_ANNIVERSARY | Cellexia Subscriber Anniversary |
| MAGIC_LINK_REQUESTED | Cellexia Magic Link Requested |
| PRE_SHIPMENT_WINDOW_OPEN | Cellexia Pre Shipment Window Open |

## Outbox semantics

**At-least-once delivery, effectively-once counting.**

- **Enqueue (at-most-once per dedupeKey):** `emitLifecycleEvent` writes an
  `OutboundEvent` with a unique `dedupeKey` (caller-supplied or a hash of
  shop + event + contract + payload). A duplicate enqueue hits the unique
  constraint and is silently dropped — the same logical event is never queued
  twice.
- **Delivery (at-least-once):** `processOutboxJob(shop?)` claims due rows
  (`status PENDING|FAILED`, `nextAttemptAt <= now`, `attempts < 8`) with a
  5-minute lease (nextAttemptAt is pushed forward while a row is in flight, so
  concurrent job runs cannot double-claim; if the process dies mid-send the
  lease expires and the row is retried).
- **Klaviyo-side idempotency:** every request carries the row's `dedupeKey` as
  Klaviyo `unique_id`. If a crash happens after Klaviyo accepted the event but
  before we marked it SENT, the redelivery is deduplicated by Klaviyo — the
  metric never double-counts.

### Retry / backoff schedule

On failure, `attempts` increments and the row is retried after
`2^attempts` minutes (pure `backoffMinutes` / `computeNextAttemptAt`):

| Failure # | Status after | Next retry in |
| --- | --- | --- |
| 1 | FAILED | 2 min |
| 2 | FAILED | 4 min |
| 3 | FAILED | 8 min |
| 4 | FAILED | 16 min |
| 5 | FAILED | 32 min |
| 6 | FAILED | 64 min |
| 7 | FAILED | 128 min |
| 8 | **DEAD** | — |

Special DEAD cases (no retries):

- Shop has Klaviyo disabled or no key → `lastError: "klaviyo disabled"`.
- Row has no `profileEmail` → `lastError: "missing profile email"`
  (should not happen; emitLifecycleEvent only enqueues when an email exists).

DEAD rows are visible in **Settings → Integrations → Outbox health** and can be
requeued in bulk with **Retry dead events** (resets `attempts` to 0). Every
DEAD transition and every job run appends an audit entry
(`outbox.event_dead`, `outbox.processed`).

### Payload enrichment

Before sending, each payload is enriched (pure `enrichPayload`):

- `portalUrl` — `PORTAL_BASE_URL` (fallback `SHOPIFY_APP_URL`) + `/portal`,
  so every email can link to "Adjust, delay or cancel online".
- `<field>Human` — a human-readable companion (e.g. `nextBillingDateHuman:
  "4 August"`) for every ISO-date-valued field, via `lib/dates.humanDate`.

Original fields are always preserved; templates can use either form.

## Klaviyo setup runbook

1. **Create the key.** Klaviyo → Settings → API keys → *Create Private API
   Key* with **Events: Full** access (Read is not enough).
2. **Configure the app.** Cellexia admin → **Settings → Integrations**: paste
   the key (stored encrypted, AES-256-GCM, never shown again), tick *Enable
   Klaviyo delivery*, save.
3. **Set the portal base.** Ensure the `PORTAL_BASE_URL` environment variable
   points at the app's public domain (used for the `portalUrl` deep link).
4. **Schedule the outbox job.** From any scheduler (cron, Fly machines,
   GitHub Actions):

   ```
   POST https://<app-domain>/jobs/outbox
   Authorization: Bearer $JOB_SECRET
   ```

   Recommended cadence: **every minute**. Magic-link emails ride this queue
   and the tokens expire after 30 minutes, so keep the interval tight.
5. **Verify.** Trigger a test event (e.g. request a portal sign-in link) and
   confirm the metric appears under Klaviyo → Analytics → Metrics as
   "Cellexia Magic Link Requested". Check Outbox health shows the row as SENT.
6. **Build the flows.** Work through the *Suggested Klaviyo flows* list in
   Settings → Integrations (source: `SUGGESTED_FLOWS` in
   `templates.server.ts`). Each card names the trigger metric, when it fires,
   and a copy skeleton in the Cellexia voice.

## Example flow wiring — payment recovery

1. In Klaviyo: **Create flow → Metric-triggered**, metric
   **"Cellexia Charge Failed"**.
2. Flow filter: *has not been in this flow in the last 7 days* (one sequence
   per billing cycle; the app already dedupes per attempt via `unique_id`).
3. Emails (skeletons in `SUGGESTED_FLOWS`, key `charge-failed-recovery`):
   - Email 1 immediately — reassurance + `{{ event.portalUrl }}` payment link.
   - Wait 3 days → Email 2 (conditional: still no
     "Cellexia Charge Completed").
   - Wait 4 days → Email 3, gentle option to delay or pause instead.
4. **Exit condition:** customer receives "Cellexia Charge Completed" — Klaviyo
   removes them from the flow so recovered customers never get dunning copy.
5. Available event properties: whatever the emitter attached (e.g.
   `amountCents`, `errorCode`), plus enrichment (`portalUrl`, `*Human` dates).

The same pattern applies to every other flow: trigger on the metric from the
table above, reference `{...}` placeholders as `{{ event.<field> }}`, keep the
voice calm and premium — "treatment plan", "delivery", "routine", and always
"Adjust, delay or cancel online".

## Voice checklist for merchants writing copy (from docs/BRAND.md)

- Say **treatment plan / routine / delivery**, never "subscription contract".
- Always offer the out: **"Adjust, delay or cancel online."**
- No countdown timers, no guilt, no discount-shouting. Benefits accumulate
  (milestones, gifts, price protection) rather than pressure.
