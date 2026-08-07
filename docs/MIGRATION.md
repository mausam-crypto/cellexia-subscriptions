# MIGRATION — importing existing subscribers

How to move live subscribers from Recharge, Skio, Appstle, Bold or Joy into
Cellexia Subscriptions with zero double-charges and zero lost renewals.

Related: [INSTALL.md](./INSTALL.md) (the app must be fully installed first),
[sample-import.csv](./sample-import.csv) (the exact file format),
[TESTING.md](./TESTING.md), [OPERATIONS.md](./OPERATIONS.md).

The importer is `scripts/import-subscribers.ts`
(`npm run import:subscribers`). It creates real Shopify contracts via
`subscriptionContractAtomicCreate`, mirrors them locally, and logs
`contract.imported` per row plus one `import.completed` event per batch
(`ImportBatch` row tracks totals/errors). Every contract it creates is stamped
**`ownership = OURS`** at creation, which is what makes it billable by this app
(see §5 and [OPERATIONS.md §18](./OPERATIONS.md#18-running-alongside-another-subscription-app)).

If the app you are migrating from **stays installed** on the store — Joy
Subscriptions on cellexialabs.com is exactly this case — read **§5 first**: the
sequence is the same, but who owns which contract now matters, and the one
thing that must never happen is both apps believing they own the same
subscription.

---

## 1. The target CSV format

One row per subscription line. Header (exact order, see
[sample-import.csv](./sample-import.csv)):

```
email,first_name,last_name,phone,variant_id,quantity,interval_weeks,next_charge_date,status,price_cents,currency,address1,address2,city,province_code,zip,country_code,payment_method_id,origin
```

| Column | Required | Notes |
|---|---|---|
| `email` | yes | Customer lookup key; must match the Shopify customer's email. |
| `first_name`, `last_name` | yes | Used if the customer must be created. |
| `phone` | no | E.164 (`+447700900123`). |
| `variant_id` | yes | Full GID: `gid://shopify/ProductVariant/…`. Numeric-only values are accepted and converted. The variant **must belong to a synced selling plan group** (Plans page) or the atomic create fails. |
| `quantity` | yes | Integer ≥ 1. |
| `interval_weeks` | yes | Whole weeks between charges (this engine is week-based — see conversion notes per source below). |
| `next_charge_date` | yes | `YYYY-MM-DD`, interpreted in the **shop's timezone**. Must be today or later; this is the first date *we* will bill. |
| `status` | yes | `ACTIVE` or `PAUSED`. Do not import cancelled subscriptions (export them for Klaviyo win-back audiences instead). |
| `price_cents` | yes | The per-unit price the subscriber currently pays, integer cents, **after** their subscription discount. Imported contracts are marked `grandfatheredPricing` so a later price propagation won't surprise them unless you include them deliberately. |
| `currency` | yes | ISO code, e.g. `GBP`. Must match the shop currency. |
| `address1`…`country_code` | yes (address2 optional) | Delivery address. `province_code` uses Shopify codes (UK: `ENG`, `SCT`, `WLS`, `NIR`). |
| `payment_method_id` | no | `gid://shopify/CustomerPaymentMethod/…` — see §3. Blank is allowed: the contract imports, but its first charge will fail into dunning and the customer gets a card-update link. Prefer migrating payment methods *first* so this column can be filled. |
| `origin` | yes | Source system, lowercase: `recharge` \| `skio` \| `appstle` \| `bold` \| `manual`. Stored for audit/analytics. |

Multi-line subscriptions: repeat the row per line with the same `email` +
`next_charge_date` + `interval_weeks`; the importer groups them into one
contract.

## 2. Export mapping per source platform

Column names below reflect each platform's standard subscription export at time
of writing — **verify against your actual file header**, these vendors rename
columns occasionally. Anything not listed maps to nothing (drop it).

### 2a. Recharge (subscription export + customer export, joined on email)

| Recharge column | → Our column | Transform |
|---|---|---|
| `customer_email` | `email` | — |
| `first_name` / `last_name` | `first_name` / `last_name` | from the customer export |
| `phone` | `phone` | normalise to E.164 |
| `shopify_variant_id` | `variant_id` | prefix `gid://shopify/ProductVariant/` |
| `quantity` | `quantity` | — |
| `order_interval_frequency` + `order_interval_unit` | `interval_weeks` | `week` → as-is; `day` → divide by 7 (round to nearest); `month` → ×4 (a "1 month" Recharge sub becomes 4-weekly — communicate this to customers or pick 5 for ~monthly-on-average) |
| `next_charge_scheduled_at` | `next_charge_date` | date part only |
| `status` | `status` | `ACTIVE` → `ACTIVE`; `CANCELLED`/`EXPIRED` → drop the row |
| `price` | `price_cents` | ×100, integer |
| `presentment_currency` | `currency` | — |
| customer export `address1/address2/city/province_code/zip/country_code` | same names | — |
| — | `payment_method_id` | not in Recharge exports; fill after payment migration (§3) |
| — | `origin` | literal `recharge` |

### 2b. Skio

| Skio column | → Our column | Transform |
|---|---|---|
| `Customer email` | `email` | — |
| `Customer first name` / `last name` | `first_name` / `last_name` | — |
| `Shopify variant id` | `variant_id` | prefix GID |
| `Quantity` | `quantity` | — |
| `Billing interval count` + `Billing interval unit` | `interval_weeks` | same conversion rules as Recharge |
| `Next billing date` | `next_charge_date` | date part |
| `Status` | `status` | `ACTIVE` → `ACTIVE`; `PAUSED` → `PAUSED`; others → drop |
| `Price` | `price_cents` | ×100 |
| `Currency` | `currency` | — |
| Shipping address columns | `address1`… | — |
| — | `origin` | literal `skio` |

### 2c. Appstle

| Appstle column | → Our column | Transform |
|---|---|---|
| `customerEmail` | `email` | — |
| `customerFirstName` / `customerLastName` | `first_name` / `last_name` | — |
| `variantId` | `variant_id` | Appstle exports the numeric id or full GID depending on report — GID-prefix if numeric |
| `quantity` | `quantity` | — |
| `billingIntervalCount` + `billingInterval` (`WEEK`/`MONTH`/`DAY`) | `interval_weeks` | same conversion rules |
| `nextBillingDate` | `next_charge_date` | date part |
| `status` | `status` | `ACTIVE`/`PAUSED` map directly; others drop |
| `currentPrice` | `price_cents` | ×100 |
| `currencyCode` | `currency` | — |
| `shippingAddress*` | `address1`… | — |
| — | `origin` | literal `appstle` |

### 2d. Bold Subscriptions (v2)

| Bold column | → Our column | Transform |
|---|---|---|
| `customer_email` | `email` | — |
| `customer_first_name` / `customer_last_name` | `first_name` / `last_name` | — |
| `platform_variant_id` | `variant_id` | prefix GID |
| `quantity` | `quantity` | — |
| `interval_number` + `interval_type` (`day`/`week`/`month`) | `interval_weeks` | same conversion rules |
| `next_order_datetime` | `next_charge_date` | date part, shop timezone |
| `subscription_status` | `status` | `active` → `ACTIVE`; `paused` → `PAUSED`; others drop |
| `price` | `price_cents` | ×100 |
| `currency` | `currency` | — |
| shipping address columns | `address1`… | — |
| — | `origin` | literal `bold` |

## 3. Payment methods — the reality

<a name="payment-methods"></a>

This is the hard part of any subscription migration. A contract without a vaulted
payment method cannot be billed. Two situations:

**A. The old app already billed through Shopify Payments / Shopify Checkout
(Skio, Appstle, Bold v2, newer Recharge).** The cards are already vaulted as
Shopify `CustomerPaymentMethod`s. Export/inspect them per customer (Shopify
admin → customer → payment methods, or the Admin API `customerPaymentMethods`
query) and fill `payment_method_id`. If a customer has exactly one vaulted
method, you may leave the column blank and let the importer pick that sole
method. Timeline: none — same-day.

**B. The old app billed through an external gateway vault (classic Recharge on
Stripe/Braintree).** Cards live in *Stripe's* vault, not Shopify's. Two routes:

1. **Shopify's dashboard-assisted gateway migration** (recommended): contact
   Shopify Support / your Plus MSM and request a payment-gateway migration into
   Shopify Payments. You arrange a PAN-level export from Stripe (Stripe support
   does this to Shopify directly — card data never touches you), Shopify imports
   it and vaults `CustomerPaymentMethod`s attached to your customers.
   **Timeline: typically 2–4 weeks** including Stripe's export queue. Plan the
   cutover date around it.
2. **`customerPaymentMethodRemoteCreate`** (keep billing through Stripe): the
   Admin API can create a Shopify payment method that *references* a Stripe
   customer + payment method (`stripePaymentMethod: { customerId: "cus_…",
   paymentMethodId: "pm_…" }`). Renewals then charge through the connected
   Stripe account. Requires the store's Stripe account to be connectable to
   Shopify and the `write_customer_payment_methods` scope (already in ours).
   Timeline: same-day once you have the Stripe id pairs (Recharge support can
   provide the customer↔Stripe mapping export). Use this when you cannot or do
   not want to move off Stripe billing.

Sequence either route **before** the import so `payment_method_id` can be
populated; blank-payment rows import fine but every one becomes a dunning case
on its first charge.

## 4. Cutover sequence

1. **Freeze the source**: disable the old app's upcoming charges (Recharge:
   pause store billing; others: set next charge dates far out or uninstall
   *after* export). At any moment exactly **one** system must believe it owns the
   next charge. If the old app stays installed on the store, this is enforced
   per subscription by the ownership model — see §5.
2. Export from the old platform, transform to our CSV (§1–2). Keep the raw
   export.
3. Payment methods migrated / mapped (§3).
4. **Dry run** — validates every row (customer exists or creatable, variant in a
   synced plan, dates sane, payment method resolvable) and writes nothing:

   ```bash
   npm run import:subscribers -- ./subscribers.csv --dry-run
   ```

   Fix the reported rows, re-run until clean. Output includes a per-row verdict
   and batch summary.
5. **Import**:

   ```bash
   npm run import:subscribers -- ./subscribers.csv
   ```

   Progress and failures land in the `ImportBatch` row (Import page shows it);
   failed rows are listed with reasons and can be re-run — the importer skips
   any email+interval that already has a live (ACTIVE **or** PAUSED) local
   contract, so re-running the same file is safe for both statuses; only
   cancelled/expired/failed contracts are eligible for re-import.
6. **Spot-check 10 contracts** across sources/statuses: open each in
   Subscribers and in Shopify admin → the customer's subscriptions. Verify next
   date, interval, price (grandfathered), address, payment method (last4),
   status, and the `contract.imported` event on the timeline.
7. **One manual billing attempt on a team member's contract**: import a row for
   a colleague with `next_charge_date` = today, then contract page → **Bill
   now**. Confirm: real charge on their card, order created, timeline shows
   `billing.attempt_succeeded` + `billing.order_created`, and the renewal email
   fires. Refund the order afterwards (Shopify admin).
8. Watch the first real renewal day closely (Dashboard + Dunning). Expect a
   slightly elevated failure rate on day 1 (stale cards from the old system) —
   that is exactly what the dunning ladder is for.

## 5. Migrating off another subscription app that stays installed (Joy Subscriptions)

<a name="5-migrating-off-another-subscription-app-that-stays-installed"></a>

cellexialabs.com runs **Joy Subscriptions** alongside this app. Shopify gives
every subscription app on a store the same `SUBSCRIPTION_CONTRACTS_*` webhooks,
so Joy's subscriptions are mirrored in our database too — and each one carries
an `ownership` value that decides whether this app may touch it:

| Value | Shown as | Billed / emailed / counted by Cellexia? |
| --- | --- | --- |
| `OURS` | *Cellexia* | Yes — everything. |
| `FOREIGN` | *Another app* | **Never.** Positive evidence it is Joy's. |
| `UNKNOWN` | *Unattributed* | **Never** — the indeterminate case fails safe. |

Two consequences to internalise before you start:

- **Nothing you do in Cellexia can charge a Joy subscriber.** Going live,
  running the billing sweep, sending reminders, importing — none of it reaches
  a contract that is not `OURS`. That isolation is the safety net; migration is
  the deliberate act of removing a subscriber from it.
- **Cellexia cannot cancel a Joy subscription for you.** Only Joy can. Which
  makes the ordering below the whole point.

### 5a. Sequence (per batch of subscribers)

1. **Export from Joy** — subscriber list with email, variant, interval, next
   charge date, price, address and (if exposed) the Shopify payment method id.
   Map it to our CSV (§1); Joy's columns map like the other platforms in §2
   (`Billing interval` → `interval_weeks`, `Next order date` →
   `next_charge_date`, price ×100 → `price_cents`, `origin` → `manual`).
2. **Cancel in Joy first.** For each subscriber you are moving, cancel (not
   pause) their Joy subscription. Only after that does anything get created
   here. If you must overlap, set the Cellexia `next_charge_date` after Joy's
   final charge date and cancel in Joy before that date — but **never leave
   both apps holding an active contract for the same subscriber**: two apps,
   two charges, one real customer, and no refund makes that a good day.
3. **Dry run, then import** (§4 steps 4–5). Imported contracts are created as
   `OURS`, so they are billable by this app as soon as you are live — and they
   are *new Shopify contracts*, unrelated to Joy's cancelled ones.
4. **Tell the customer.** Their old subscription ends and a new one begins:
   the charge descriptor, the portal link and the management emails all change.
   Send the "we've upgraded your subscription" note before the first Cellexia
   renewal.
5. **Check the scoreboard**: Preview & launch → **Other subscription apps** —
   `Another app` should drop by the number you migrated, `Cellexia` should rise
   by the same number.

### 5b. Claiming — for contracts that are ours but cannot prove it

A contract is filed `UNKNOWN` when nothing on it proves ownership: no selling
plan on any line (contracts created by `subscriptionContractAtomicCreate` carry
none), or our own plan ids were unreadable when it was classified. `UNKNOWN` is
never billed, so **our own** subscribers can sit there unbilled after an
upgrade or an unusual import path.

Fix it in the admin:

> Subscribers → **Managed by: Unattributed** → select the rows → **Claim as
> Cellexia's**

Claiming sets `UNKNOWN` → `OURS` and logs one `admin.action` per contract
(`contract_ownership_claimed`, visible on the Audit page and the subscriber's
timeline). It **refuses to touch `FOREIGN` rows** — a contract positively
identified as another app's can never be claimed, precisely because claiming it
would start a second app billing a live subscription. To move a `FOREIGN`
subscriber over, cancel in that app and re-import (§5a); there is no shortcut,
by design.

Before claiming in bulk, run Preview & launch → **Re-check subscription
ownership** once: it reads contracts back from Shopify and files everything it
can decide automatically, so the list you are about to claim is genuinely the
leftovers. On a store with more than 1 000 subscriptions, run it until the
"unattributed" number stops falling (each run makes at most 1 000 Shopify
re-fetches).

### 5c. When Joy is empty — uninstalling it

Uninstalling Joy does **not** move anyone to Cellexia; it stops Joy's billing,
and ours never started for those customers. Work through
[OPERATIONS.md §18 → "Before you uninstall the other app"](./OPERATIONS.md#18-running-alongside-another-subscription-app)
first: export while you still can, migrate, claim the leftovers, confirm
`Another app` is 0 and that Joy's selling plan groups are gone from your
products (a leftover group renders an unmanaged subscribe widget on the PDP).
Cancelled Joy contracts stay in our mirror as `FOREIGN` history — harmless,
nothing acts on them.
