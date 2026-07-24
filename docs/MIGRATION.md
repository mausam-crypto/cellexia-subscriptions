# MIGRATION — importing existing subscribers

How to move live subscribers from Recharge, Skio, Appstle or Bold into Cellexia
Subscriptions with zero double-charges and zero lost renewals.

Related: [INSTALL.md](./INSTALL.md) (the app must be fully installed first),
[sample-import.csv](./sample-import.csv) (the exact file format),
[TESTING.md](./TESTING.md), [OPERATIONS.md](./OPERATIONS.md).

The importer is `scripts/import-subscribers.ts`
(`npm run import:subscribers`). It creates real Shopify contracts via
`subscriptionContractAtomicCreate`, mirrors them locally, and logs
`contract.imported` per row plus one `import.completed` event per batch
(`ImportBatch` row tracks totals/errors).

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
   Shopify. NOTE: `write_customer_payment_methods` is not a real Shopify
   scope (rejected at deploy validation, removed from shopify.app.toml) —
   before relying on `customerPaymentMethodRemoteCreate`, re-check Shopify's
   current docs for whatever scope actually gates it.
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
   next charge.
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
   emails+variants that already have an active imported contract, so re-running
   is safe.
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
