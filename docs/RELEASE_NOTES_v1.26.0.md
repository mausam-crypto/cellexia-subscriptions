# Release notes v1.26.0: buy-box design measurement

For the developer applying the update. Read together with
[UPDATE.md](./UPDATE.md) (the general procedure) and the
[CHANGELOG](../CHANGELOG.md) entry.

## What changes at a glance

| Area | Change | Deploy step |
|---|---|---|
| Database | Migration `0025_design_measurement`: 5 nullable columns on `SubscriptionContract`, 1 on `WidgetDesignRevision`, new tables `SubscribableOrder` and `MarketCountryMap`. Additive only. | `npm run setup` (or `npx prisma migrate deploy`) |
| Server | New module `app/lib/design-measurement/`, ORDERS_CREATE and contract webhooks write design facts, new daily job `design_facts_backfill`, new self-check `design_facts`, new settings group `designMeasurement`, two new analytics filter dimensions, Buy box designer Results tab and resource route `/app/buy-box/results`. | Deploy and restart the host |
| Storefront extension | `assets/buy-box.js` and `assets/buy-box-embed.js` changed (new hidden line property `_cellexia_seen`; `getState()` exposes `preselect`). **No `.liquid` file changed.** | `npm run deploy` |
| Scopes, webhooks, env vars, app proxy | Unchanged. | Nothing |

## Size budgets (verified by `npm run verify`)

| File | Bytes | Limit | Headroom |
|---|---|---|---|
| All `.liquid` files (total, the Shopify hard limit is 102,400) | 89,934 (unchanged) | 90,112 | 178 |
| `assets/buy-box.js` | 114,314 | 114,688 | 374 |
| `assets/buy-box-embed.js` | about 54,300 | 114,688 | about 60,000 |
| `assets/buy-box.css` | 46,431 (unchanged) | 65,536 | 19,105 |

`tests/liquid/size-limits.test.ts` fails the build before any of these can
be exceeded, so a green `npm run verify` means the extension will not be
rejected for size at `shopify app deploy`.

## Exact order of operations

1. Back up the database (UPDATE.md section 4, step 2).
2. Unzip `cellexia-subscriptions-v1.26.0.zip` over the previous directory,
   keeping `.env` and `fly.toml`. Commit to your own git repo and review the
   diff.
3. `npm ci`
4. `npm run setup` (runs `prisma generate` and `prisma migrate deploy`; it
   applies `0025_design_measurement`). Safe before the new code is deployed:
   v1.25 code ignores the new columns and tables.
5. Deploy and restart the server (`flyctl deploy` or your host's equivalent).
6. `npm run deploy` for the theme app extension. Do this AFTER step 5: the
   new server tolerates orders with or without `_cellexia_seen`, whereas a
   v1.25 server ignores the new property entirely (orders placed in that
   window get their design fact rows later, from the nightly backfill's
   rebuild of the event feed, without the storefront exposure record).
7. Verify (below).

Steps 5 and 6 in the reverse order do not break anything; they only lose the
storefront exposure record for orders placed in between.

## How to verify after deploying

Admin:

- Debug page: the new `design_facts` check is PASS (it compares the
  `checkout.subscribable` event feed with the fact table; on a fresh install
  both are 0 and it passes).
- Debug page: `jobs_health` stays green after the first scheduler tick (the
  new daily `design_facts_backfill` job runs once on that tick; its JobRun
  row is in the database, the Debug page is where a failing job would show).
- Buy box designer: a fifth tab **Results** in the editor card. Before the
  store has orders it shows an explanation of what will be measured, plus the
  Guardrails and settings card. Enter the staff and test-buyer emails and the
  measurement start date there and save; the toast confirms.
- Analytics page: the filter bar has two new selects, **Buy-box design** and
  **Preselected option** (both show only "Unknown" until subscribers exist).
- Publish dialog on the Buy box designer: a new optional "Name this design"
  field; the name appears in the revision history.

Storefront (with the widget visible, that is after go-live or with the
admin preview token):

- Add the product to the cart with **one-time** selected, then open
  `/cart.js` in the browser: the line carries
  `"properties": {"_cellexia_seen": "<preset>|s"}` (or `|o` when one-time was
  preselected). Nothing else on the line changed.
- Add with **subscription** selected: the line carries `selling_plan`,
  `_cellexia_design` (as before) and `_cellexia_seen`.
- Any other vendor's add-to-cart on the same page (bundle widget, upsell) is
  untouched.
- The cart drawer / cart page should not display the underscore-prefixed
  properties. Shopify's checkout hides them; most themes hide them in the
  cart template as well. If your theme prints them, its cart template needs
  the usual `{% unless property.first.first == '_' %}` guard, exactly as it
  already needed for `_cellexia_design` on subscription lines.
- Known cosmetic effect: a one-time line added on the product page (stamped)
  and a one-time line of the same variant added somewhere without the widget
  (collection quick-add, cart upsell) no longer merge into one line with
  quantity 2; they show as two lines. Checkout and totals are unaffected.

## Rollback

- Server: redeploy v1.25.0 (`git checkout` your previous release tag,
  `npm ci`, deploy). Leave the database as it is (UPDATE.md section 5): the
  new columns and tables are ignored by v1.25 code and nothing depends on
  them.
- Extension: the deployed v1.26.0 extension keeps stamping `_cellexia_seen`;
  a v1.25 server ignores it. If you also want the storefront back on the old
  assets, run `npm run deploy` from the v1.25.0 tree.
- Data written meanwhile (`SubscribableOrder` rows, `originDesign*` stamps)
  stays and becomes useful again when you re-apply v1.26.0; the nightly
  backfill rebuilds any rows the v1.25 server did not write from the event
  feed.

## What the merchant will do with it

The Results tab reads the store's own orders. It needs nothing else, but two
optional inputs make it more useful:

- Guardrails and settings: staff and test-buyer emails (left out of every
  number), the measurement start date, the tolerated weekly-orders drop and
  the minimum-orders floor for guardrails.
- Weekly view: product-page sessions per week from Shopify Analytics, typed
  in, to turn orders into a conversion rate per week and per design.

The tab explains each number where it appears. Comparisons between designs
are honest only when the merchant changes one design at a time, in whole
weeks, with the same design in every market; the guide at the bottom of the
tab says so.

## For the curious: where things live

- `app/lib/design-measurement/shared.ts`: property name, seen-value parser,
  labels (client-safe).
- `ledger.server.ts`: the design calendar from published revisions.
- `facts.server.ts`: the fact writer and the contract link (write-once).
- `backfill.server.ts`: the nightly job body.
- `markets.server.ts`: country to market map (Admin API 2025-01
  `markets.regions`; the query is contained, so a future API removal only
  leaves `marketHandle` empty).
- `scoreboard.server.ts` + `types.ts`: the readout engine and the one pure
  statistic (Beta comparison for "chance it beats the reference").
- `app/routes/app.buy-box_.results.tsx`: the resource route (loader + action)
  the tab talks to; `app/components/design-results.tsx`: the tab.
- Storefront: `_cellexia_seen` writers in `buy-box.js` (theme form) and
  `buy-box-embed.js` (fetch/XHR patch); README section "The `_cellexia_seen`
  line property".
