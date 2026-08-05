# Customer-service console — subscribers module

Routes: `app/routes/app.subscribers.tsx` (list) and
`app/routes/app.subscribers.$id.tsx` (console). Pure parsing/decision helpers
live in `app/services/subscribers/actions.ts` and are unit-tested in
`tests/subscribers/actions.test.ts`.

## Who can use it (RBAC)

Both routes call `requireRole(session, "OWNER", "ADMIN", "CS_AGENT")`
(`~/services/core/rbac.server`) with the session returned by
`authenticate.admin` — the staff identity is the session email. `ANALYST`
roles are refused: the subscriber console is a write surface, analysts get
read-only analytics elsewhere. Every override is attributed to the staff email
that performed it.

## The list (`/app/subscribers`)

- Summary cards: active plans, paused, in payment recovery (dunning phase in
  PRE_DUNNING / RETRYING / GRACE / FINAL_NOTICE), high churn risk (active
  plans with churn score ≥ 0.7).
- Filters: status, churn-risk band (LOW < 0.4 ≤ MEDIUM < 0.7 ≤ HIGH — scores
  are stored on a 0–1 scale), dunning phase, next-billing window (overdue /
  7 / 14 / 30 days), email search. All filters are plain GET query params, so
  filtered views are shareable URLs.
- Columns: customer, status, products summary, cadence, next billing (with an
  Overdue badge), successful orders, lifetime revenue, quality and churn
  scores as tone-coloured badges. Row click opens the console. 25 rows per
  page.

## The console (`/app/subscribers/:id`)

Read view: full plan overview (cadence, schedule, card summary with
expiry warnings, delivery address), lines with prices and per-line depletion
estimates, add-ons, latest QUALITY / CHURN_RISK / LTV score snapshots with
factor breakdowns, milestones, acquisition attribution, dunning state with
the step-by-step recovery timeline and recent billing attempts, cancellation
session history, the contract's audit-log slice as a change-history timeline,
and a lifecycle event feed (AnalyticsEvent rows for this contract).

### Manual overrides

Every override from the core contract API is available, each behind a confirm
modal:

| Action | Core function | Notes |
| --- | --- | --- |
| Change quantity | `updateLineQuantity` | per line, capped at 24 |
| Swap variant | `swapLineVariant` | accepts numeric ID or variant GID |
| Add product | `addLineToContract` | optional price override (decimal → cents) |
| Remove line | `removeLineFromContract` | destructive |
| Set next billing date | `setNextBillingDate` | future dates only |
| Skip next | `skipNextShipment` | |
| Delay N weeks | `delayByWeeks` | 1–12 weeks |
| Bring forward | `bringForward` | future dates only |
| Pause 30/60/90 or until date | `pauseUntil` | presets from `PAUSE_OPTIONS_DAYS` |
| Resume | `resumeContract` | only offered when paused |
| Switch cadence | `switchCadence` | 1–24 weeks |
| Update address | `updateDeliveryAddress` | validated, country upper-cased |
| Send payment-update email | `sendPaymentUpdateEmail` | no card data touches the console |
| Apply account credit | `applyAccountCredit` | one-cycle discount, capped at 500.00 per action |
| Cancel | `cancelContract` | reason required from `CANCEL_REASONS`; destructive |
| Merge into | `mergeContracts(target, [this])` | this plan's products move into the selected plan of the same customer |
| Split lines | `splitContract` | selected lines move to a new plan; at least one line must stay |

### Safety rails

- **Double confirmation** for destructive actions (remove line, cancel,
  merge, split): the modal itself plus an "I understand" checkbox that the
  server re-validates (`confirm=yes`) — the UI cannot be bypassed with a
  hand-crafted POST.
- **Idempotent submissions**: the loader issues a one-time `formToken`; the
  action wraps the core call in
  `withIdempotency("cs:<contractId>:<intent>:<token>", "cs-console", …)`, so a
  double-click or browser retry never fires the same override twice.
- **Validation before side effects**: all form parsing/validation happens in
  the pure `parseConsoleAction` before any Shopify call, and invalid input
  never consumes the idempotency token.
- **Guardrails**: quantity ≤ 24, delay ≤ 12 weeks, cadence 1–24 weeks, credit
  ≤ 500.00 per action, dates must be in the future.
- **Errors** surface as a Polaris critical Banner (inside the open modal, or
  at the top of the page) carrying the Shopify `userError` message when the
  mutation was rejected; successes show a toast.

### Audit guarantees

- The core contract functions append their own audit entries and emit
  lifecycle events internally.
- On top of that, every successful console override appends a
  **STAFF-attributed** entry: `actorType: "STAFF"`, `actorId: <staff email>`,
  `action: "CS_<INTENT>"` (e.g. `CS_SKIP_SHIPMENT`), `subjectType:
  "SubscriptionContract"`, `subjectId: <contract cuid>`, payload = the parsed
  action parameters. Replayed (idempotent) submissions do **not** append a
  duplicate entry.
- The audit log is append-only and hash-chained per shop
  (`services/audit.server.ts`); the console renders the contract's slice
  (`subjectId = contract id`) so agents see the full change history including
  webhook- and customer-driven changes.

### Voice

Staff-facing copy stays in the Continuous Treatment vocabulary — "treatment
plan", "delivery", "cadence", never raw subscription-contract jargon — and the
cancel modal nudges agents toward structural saves (pause, slower cadence,
smaller delivery) before cancelling, mirroring the retention engine's
cheapest-first ladder.
