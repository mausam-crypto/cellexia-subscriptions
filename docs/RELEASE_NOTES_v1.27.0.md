# Release notes v1.27.0: visit tracking and conversion per widget design

For the developer applying the update. This release supersedes v1.26.0
(cut the same day, not deployed): apply v1.27.0 directly from v1.25.0. It
contains everything in [RELEASE_NOTES_v1.26.0.md](./RELEASE_NOTES_v1.26.0.md)
plus the storefront visit beacon. Read together with [UPDATE.md](./UPDATE.md)
and the [CHANGELOG](../CHANGELOG.md).

## What changes at a glance (v1.25.0 → v1.27.0)

| Area | Change | Deploy step |
|---|---|---|
| Database | Migrations `0025_design_measurement` and `0026_widget_visits`. Additive only (nullable columns, new tables `SubscribableOrder`, `MarketCountryMap`, `WidgetVisitorDay`). | `npm run setup` |
| Server | Design measurement module, webhook fact writes, `design_facts_backfill` job, `design_facts` and `widget_visits` self-checks, `designMeasurement` settings, two analytics filter dimensions, Buy box designer Results tab, resource route `/app/buy-box/results`, storefront beacon endpoint `/apps/cellexia-subs/w`. | Deploy and restart the host |
| Storefront extension | `assets/buy-box.js` (v1.26.0: `_cellexia_seen` line property, `getState().preselect`) and `assets/buy-box-embed.js` (v1.26.0: seen stamping; v1.27.0: visit beacon). **No `.liquid` file changed.** | `npm run deploy` |
| Scopes, webhooks, env vars, app proxy config | Unchanged. The beacon uses the existing app proxy (`/apps/cellexia-subs/*`). | Nothing |

## Size budgets (verified by `npm run verify`)

| File | Bytes | Limit | Headroom |
|---|---|---|---|
| All `.liquid` files (total; Shopify hard limit 102,400) | 89,934 (unchanged) | 90,112 | 178 |
| `assets/buy-box.js` | 114,314 | 114,688 | 374 |
| `assets/buy-box-embed.js` | 73,998 | 114,688 | 40,690 |
| `assets/buy-box.css` | 46,431 (unchanged) | 65,536 | 19,105 |

`tests/liquid/size-limits.test.ts` fails the build before any of these can be
exceeded, so a green `npm run verify` means `shopify app deploy` will not
reject the extension for size.

## Exact order of operations

1. Back up the database (UPDATE.md section 4, step 2).
2. Unzip `cellexia-subscriptions-v1.27.0.zip` over the previous directory,
   keeping `.env` and `fly.toml`. Commit to your own git repo and review the
   diff.
3. `npm ci`
4. `npm run setup` (applies 0025 and 0026; safe before the new code runs:
   v1.25 code ignores the new columns and tables).
5. Deploy and restart the server.
6. `npm run deploy` for the theme app extension. AFTER step 5: the new
   server accepts orders with or without the new line property and answers
   the beacon; a v1.25 server would ignore both (the beacon would get a 404
   from the old server: no effect on the page, only a failed request in the
   browser's network tab).
7. In the theme editor confirm the **Cellexia buy box app embed is enabled**
   (the live preview on cellexialabs.com already runs through the embed
   because that theme has no product form; confirm it is still on).
   Visit tracking runs from the embed script; a theme that only uses the app
   block would still get the design stamp on orders but no visits.
8. Verify (below).

## How to verify after deploying

Admin:

- Debug page: `design_facts` PASS; `widget_visits` PASS (before go-live it
  passes because the store is not live; after go-live it warns only if
  orders with widget exposure arrive while zero visits are recorded).
- Buy box designer → Results: before the first order it shows what will be
  measured plus the Guardrails and settings card; enter staff and test-buyer
  emails and the measurement start date and save.
- Analytics page: two new filters, Buy-box design and Preselected option.
- Publish dialog: optional "Name this design" field.

Storefront (widget visible, so after go-live or with the admin preview
token; note the beacon deliberately does NOT fire in admin preview or in the
theme editor, so visit checks need the live widget in a normal browser tab):

- Open a product page, then the browser network tab: within about a second
  of the widget being on screen there is a request
  `GET /apps/cellexia-subs/w?e=view&d=<preset>&p=s|o|u&v=<variant>&c=<country>&cur=<currency>&dv=m|t|d&vid=…&pv=…&t=…`
  answered with `204`. Click inside the widget: an `e=engage` request. Add to
  cart: an `e=atc&m=s|o` request, and the cart line carries
  `_cellexia_seen` (and `_cellexia_design` plus `selling_plan` for a
  subscription add).
- Any other vendor's add to cart on the page is untouched; the cart request
  itself is unchanged whether or not the beacon succeeded.
- `localStorage` holds `cellexia_vid` (a random 16-character id). No cookie
  is set.
- Cosmetic (from v1.26.0): a one-time cart line added on the product page and
  one of the same variant added elsewhere without the widget do not merge.

## Rollback

- Server: redeploy v1.25.0; leave the database as it is. The deployed
  v1.27.0 extension keeps stamping `_cellexia_seen` and sending beacons; a
  v1.25 server ignores the property and answers the beacon path with a 404
  the storefront swallows. To silence it, `npm run deploy` from the v1.25.0
  tree.
- Data written meanwhile stays and becomes useful again on re-apply.

## What the merchant reads

The Results tab compares each design (and whether subscription was
preselected) on: visits, conversion (orders per 100 visits), subscription
conversion (subscriptions per 100 visits), take rate (subscribed ÷ orders),
kept take rate at 30/60/90 days, kept subscribers per 100 visits at 30 days,
quick cancels, LTGP per subscriber, plus guardrails (weekly conversion once
both sides have two full weeks of visits, otherwise weekly orders; the
guardrail baseline is always the design with the most orders), a
compare-against-reference card with "chance it is really better" against
the design picked under "Compare against", data quality (visit coverage, last visit,
seen coverage, calendar agreement, exclusions), the design calendar, and a
guide. Visits are visitor-days: a person counts once per day per design.
Conversion counts only orders placed on days with recorded visits, so the
first weeks after deployment read "orders counted since <date>".

## Where things live (new in v1.27.0)

- `extensions/cellexia-buy-box/assets/buy-box-embed.js` section 4 "Visit
  beacon"; README section "Visit beacon (v1.27.0)".
- `app/routes/proxy.w.tsx` (GET `/apps/cellexia-subs/w`, always 204).
- `app/lib/design-measurement/visits.server.ts` (ledger writer, summary,
  prune, market recompute, beacon parsing, token buckets, bot filter).
- `app/lib/design-measurement/scoreboard.server.ts` (visits join,
  conversion, guardrail basis, comparison), `types.ts`.
- `app/components/design-results.tsx` (new columns and cards).
- `prisma/migrations/0026_widget_visits/migration.sql`.
