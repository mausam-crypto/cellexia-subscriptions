# Operational scripts

CLI tools for migration, local seeding and monitoring. All scripts:

- run via **tsx** from the **project root** (tsx resolves the app's `~/` alias
  through `tsconfig.json`, so run them from the repo root, not from `scripts/`),
- load `.env` (then `.env.local`) from the project root automatically — no
  dotenv dependency; values already exported in the environment win,
- use only integer cents for money and full GIDs for Shopify IDs,
- log canonical events (`contract.imported`, `import.completed`, `admin.action`)
  through the shared `logEvent()` seam.

npm shortcuts exist for each: `npm run import:subscribers`, `npm run seed:demo`,
`npm run healthcheck` (pass script flags after `--`).

Required environment (`.env`):

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | import, seed | Postgres connection for Prisma |
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` / `SCOPES` | import | Admin API client (offline session) |
| `SHOPIFY_APP_URL` | import, healthcheck | App base URL |
| `APP_URL` (optional) | healthcheck | Overrides `SHOPIFY_APP_URL` for the probe |

---

## import-subscribers.ts

Migrates subscribers from a CSV export (Recharge, Bold, spreadsheet…) into
**native Shopify subscription contracts** via `subscriptionContractAtomicCreate`,
mirrors each contract into the local database, marks it
`grandfatheredPricing = true` (imported subscribers keep their migrated price)
and logs `contract.imported` per contract plus one `import.completed` for the
batch. Every run (except dry-runs) is recorded as an `ImportBatch` row with
per-row errors in its `errors` JSON.

```sh
# Validate everything, mutate nothing:
npx tsx scripts/import-subscribers.ts --file docs/sample-import.csv --dry-run

# Real import against the single installed shop:
npx tsx scripts/import-subscribers.ts --file exports/recharge-2026-07.csv

# Explicit shop:
npx tsx scripts/import-subscribers.ts --file export.csv --shop cellexia.myshopify.com

# via npm:
npm run import:subscribers -- --file export.csv --dry-run
```

### CSV format

Header row required (any column order); see `docs/sample-import.csv`.

| Column | Required | Notes |
|---|---|---|
| `email` | yes | lowercased; grouping key |
| `first_name`, `last_name`, `phone` | no | phone is dropped automatically if Shopify rejects it on customer create |
| `variant_id` | yes | numeric ID or full `gid://shopify/ProductVariant/…`; validated against Shopify |
| `quantity` | no (default 1) | integer ≥ 1 |
| `interval_weeks` | yes | 1–52; billing **and** delivery interval (WEEK-based) |
| `next_charge_date` | yes | `YYYY-MM-DD` or ISO-8601; past dates are moved to tomorrow (shop timezone) with a warning |
| `status` | no (default ACTIVE) | `ACTIVE` or `PAUSED` (`ENABLED` is treated as ACTIVE) |
| `price_cents` | yes | integer cents (e.g. `2999`, never `29.99`) |
| `currency` | yes | 3-letter ISO code |
| `address1`, `city`, `country_code` | yes | shipping address; `address2`, `province_code`, `zip` optional |
| `payment_method_id` | no | `CustomerPaymentMethod` token or GID; when empty the customer's first non-revoked vaulted method is used |
| `origin` | no | source platform label; stored on the contract note and in the event payload |

### Semantics

- **Grouping**: rows sharing `email` + `interval_weeks` become **one contract**
  with one line per distinct variant (duplicate variants merge quantities).
  Contract-level values (status, currency, next charge date, address, payment
  method) come from the group's first row; conflicts are reported as warnings.
- **Idempotent**: an email that already has an ACTIVE local contract with the
  same interval is reported `SKIPPED_DUPLICATE` and untouched — safe to re-run
  a partially failed import.
- **Customers**: resolved by exact email; created (inline `customerCreate`)
  only when a contract will actually be created for them.
- **Payment methods**: rows whose customer has **no** resolvable vaulted
  payment method are reported `SKIPPED`, never half-imported. Vault cards
  first — `docs/MIGRATION.md` explains the vaulting step.
- **--dry-run** performs every read and validation (including Shopify customer,
  payment-method and variant lookups) but performs **no mutation anywhere** —
  no Shopify writes, no `ImportBatch`, no events.
- **Mirroring**: after each create the script calls the contracts module's
  `syncContractFromShopify` seam when available and otherwise falls back to a
  built-in local mirror, then applies the grandfather flag.
- Historic cycle counts / lifetime revenue are *not* migrated; analytics start
  from the import date.

Exit codes: `0` success (skips/duplicates allowed), `1` any row/group error,
`2` usage error.

### Prerequisites

1. App installed on the shop (offline Admin session in the database).
2. Payment methods vaulted in Shopify (see `docs/MIGRATION.md`).
3. Products/variants exist in Shopify (the script verifies every `variant_id`).

---

## seed-demo.ts

Local/dev seed. Idempotent — re-running never overwrites your edits.

```sh
npx tsx scripts/seed-demo.ts --shop my-dev-store.myshopify.com
# or, once the app is installed, simply:
npm run seed:demo
```

Creates:

- the `Shop` row for the domain (schema defaults; a real install later syncs
  currency/timezone/locales),
- a demo `SellingPlanConfig` — frequencies **6/8/10/12 weeks**, default 8,
  schema-default offer architecture (20% first order, 10% ongoing),
  `syncStatus = PENDING` until synced to Shopify from the admin UI,
- three `GiftRule`s: **cycle-2 surprise** (unannounced), **order-6 milestone**
  (announced), **365-day anniversary** (announced).

Gift rules are seeded **inactive** with `gid://shopify/ProductVariant/REPLACE_ME`
placeholders so the gift engine can never push a placeholder variant into a
real billing cycle. Replace the GIDs (and `unitCostCents`), then activate.
The script prints the exact next steps.

---

## healthcheck.ts

Probes `{APP_URL}/api/health` and pretty-prints the JSON response. Intended
for cron/CI.

```sh
npx tsx scripts/healthcheck.ts
npx tsx scripts/healthcheck.ts --url https://staging.example.com
npx tsx scripts/healthcheck.ts --url https://example.com/api/health --timeout-ms 5000
```

Verdict: HTTP 2xx required; if the body has `healthy`/`ok` booleans or a
`status`/`state` string, it must read healthy too.

Exit codes: `0` healthy, `1` unhealthy or unreachable, `2` configuration error.

Cron example (alert on failure):

```cron
*/5 * * * * cd /srv/cellexia && npx tsx scripts/healthcheck.ts >> /var/log/cellexia-health.log 2>&1 || /usr/local/bin/notify-oncall "cellexia healthcheck failed"
```
