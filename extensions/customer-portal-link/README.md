# customer-portal-link — customer account UI extension

Surfaces an elegant **"Your Continuous Treatment"** card inside the new
Shopify customer accounts, on two targets:

- `customer-account.profile.block.render` (Profile page)
- `customer-account.order-index.block.render` (Order index page)

The card is a **pure link surface**: no data fetching, no network access, no
session tokens. It renders brand-voice copy and a single button pointing at
the app-proxy portal hand-off:

```
/apps/cellexia/portal-link
```

When the extension API exposes `shop.storefrontUrl` the link is absolute
(`https://<shop-domain>/apps/cellexia/portal-link`); otherwise it falls back
to the relative path. URL assembly lives in `src/portalUrl.ts` (pure, unit
tested at `tests/account-ext.portalUrl.test.ts` in the repo root).

## How the hand-off logs the customer in

1. The customer is already authenticated inside customer accounts, which also
   means they hold a storefront session on the shop domain.
2. Clicking the button loads `https://<shop-domain>/apps/cellexia/portal-link`.
   Shopify's **app proxy** forwards this to the app's `/proxy/portal-link`
   route (see `[app_proxy]` in `shopify.app.toml`) with HMAC-signed query
   parameters, including **`logged_in_customer_id`** — the shop's verified
   identity of the browsing customer.
3. The portal module (`app/routes/proxy.portal-link.tsx`, owner: [portal])
   verifies the request with `authenticate.public.appProxy`, trusts only
   `logged_in_customer_id` from the verified proxy context (never bare query
   params), creates a signed portal session cookie, and redirects into the
   treatment portal — **no password, no magic-link email needed**.
4. If `logged_in_customer_id` is empty (customer not logged in on the
   storefront), the route falls back to the magic-link request flow.

## Copy / localisation

Strings live in `locales/en.default.json` and follow the Continuous Treatment
voice (`docs/BRAND.md`): "treatment plan", "routine", "delivery" — never raw
subscription jargon — plus the standing reassurance line "Adjust, delay or
cancel online." The component keeps hard-coded English fallbacks so the card
never renders blank if a translation key is missing.

## Develop & deploy

- `npm run dev` (root) — `shopify app dev` serves the extension in dev mode;
  preview it from the customer accounts editor.
- `npm run deploy` (root) — `shopify app deploy` bundles and releases the
  extension as part of the app version. After deploying, a merchant places
  the block via **Settings → Checkout and customer accounts → Customize →
  Profile / Orders** (it targets both pages).
- Dependencies are installed by the root workspace
  (`"workspaces": ["extensions/*"]` in the root `package.json`).

This workspace is excluded from the root `tsc` run; `tsconfig.json` here is
self-contained (`jsx: react-jsx`, `moduleResolution: Bundler`, strict).
