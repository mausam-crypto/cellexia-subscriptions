# Demo mode — local admin preview without a Shopify store

Demo mode lets you open the full Cellexia admin (`/app/**`) on localhost with
**no Shopify store, no OAuth, and no App Bridge**. It exists purely so the
admin UI can be previewed and demoed over locally seeded data.

## Security warning — read this first

Setting `DEMO_MODE=1` **bypasses admin authentication entirely**. Every
request to an admin route is treated as an authenticated staff session for the
demo shop, with no credentials of any kind. Consequences:

- **Never set `DEMO_MODE` in production, staging, or any deployment that is
  reachable from a network you do not fully control.** Anyone who can reach
  the server has full admin access to whatever data is in the database.
- The server logs a loud warning at startup when demo mode is active
  (`DEMO_MODE=1 — admin auth is BYPASSED; never set this in production`).
  If you ever see that line in a deployed environment, treat it as an
  incident.
- Demo mode is keyed strictly off `process.env.DEMO_MODE === "1"`; leaving
  the variable unset (or set to anything else) keeps the real
  `authenticate.admin` OAuth flow.

## How it works

`app/shopify.server.ts` builds the real `shopifyApp(...)` object as always.
When `DEMO_MODE=1`, the exported `authenticate` object is the real one with a
single override: `authenticate.admin` resolves to a fake context instead of
running Shopify OAuth:

- `session`: shop `cellexia-demo.myshopify.com` (override with `DEMO_SHOP`;
  it must match what `scripts/seed-demo.mjs` seeds), staff identity
  `demo-admin@cellexia.test` (satisfies `session.shop` reads and RBAC's
  `staffEmailFromSession`).
- `admin.graphql`: **always throws** — `"Demo mode: Shopify Admin API calls
  are disabled — connect a real store with 'shopify app config link' to
  enable actions."` So nothing can accidentally call Shopify.

All other `authenticate` members (`webhook`, `public`, …) and all other
exports (`login`, `registerWebhooks`, `unauthenticated`, `sessionStorage`)
remain the real implementations.

`app/routes/app.tsx` additionally returns `demoMode` from its loader. In demo
mode it skips the App Bridge `AppProvider`/`NavMenu` (those require the
embedded Shopify admin iframe and would error or redirect on localhost) and
renders a plain Polaris `AppProvider` with a slim top nav linking to every
admin section, plus a `DEMO MODE — Shopify actions disabled` badge. Outside
demo mode the embedded App Bridge path is byte-for-byte the previous
behaviour.

## Running it

```sh
npm run preview:local
```

That script sets `DEMO_MODE=1` (plus dev-safe values for the other required
env vars) and serves the built app on <http://localhost:3901>. Typical full
flow from a clean checkout:

```sh
npm install
npx prisma migrate dev            # DATABASE_URL=file:./dev.sqlite
DATABASE_URL="file:./dev.sqlite" node scripts/seed-demo.mjs
npm run build
npm run preview:local             # then open http://localhost:3901/app
```

Optional env:

- `DEMO_SHOP` — shop domain for the fake session. Defaults to
  `cellexia-demo.myshopify.com`; only change it if you also seed data for
  that shop.

## What works

Every admin **read** view, backed by whatever the seed script put in the
local SQLite database:

- `/app` executive dashboard, `/app/analytics` (cohorts, survival, forecast)
- `/app/subscribers` and the subscriber CS console (`/app/subscribers/:id`)
- `/app/plans`, `/app/widgets`, `/app/retention`, `/app/dunning`,
  `/app/treatment`, `/app/settings`

Actions that only touch the local database (e.g. saving local-only config)
also work, because they never call Shopify.

## What intentionally fails

Any action whose handler calls the Shopify Admin API — contract edits, skips
and pauses, billing attempts, selling-plan pushes, payment-update emails,
etc. The fake `admin.graphql` throws, and the route surfaces the demo-mode
error ("Demo mode: Shopify Admin API calls are disabled — connect a real
store with 'shopify app config link' to enable actions."). This is by design:
the preview demonstrates the UI and read paths without ever risking a real
API call. To exercise actions for real, link the app to a Partner app and
development store (`shopify app config link`, then `shopify app dev`) and run
without `DEMO_MODE`.
