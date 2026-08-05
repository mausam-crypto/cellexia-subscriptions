# Cellexia customer portal [portal]

The customer-facing **treatment dashboard** — magic-link authenticated,
Cellexia-branded (pure HTML/CSS, no Polaris), served from the app domain
(`PORTAL_BASE_URL`). It is a treatment companion, not an account-management
screen: routine, next delivery, supply, savings, milestones — with the
controls close at hand.

## Authentication

### Magic link

1. Customer enters their email at `/portal/login` (or posts it to the app
   proxy — see below).
2. `requestMagicLink(shop, email)` looks up their contracts by email, mints a
   random 32-byte token (`generateToken`), stores **only its SHA-256 hash**
   in `MagicLinkToken` (30-minute expiry, single use), and emits
   `MAGIC_LINK_REQUESTED` with the link
   `PORTAL_BASE_URL/portal/magic/<token>`. Klaviyo delivers the email.
3. The response is **always success** — no account enumeration. Unknown
   emails follow the same code path length and get the same UI.
4. `/portal/magic/:token` → `verifyMagicLinkAndCreateSession`: hash lookup,
   must be unexpired and unused, claimed **atomically** (`updateMany` on
   `usedAt: null`), then a signed session cookie is set and the customer
   lands on `/portal`. Invalid/expired/used tokens render a friendly retry
   screen with a one-tap "request a fresh link".

Session cookie: `cx_portal` — httpOnly, secure, SameSite=Lax, 14 days,
signed with `MAGIC_LINK_SECRET` (fallback `SHOPIFY_API_SECRET`). Session data:
`{shop, shopifyCustomerId, email}`.

### App-proxy hand-off (storefront "Manage my treatment")

`/apps/cellexia/portal-link` → `proxy.portal-link.tsx`:

- Request is verified with `authenticate.public.appProxy` (HMAC). Customer
  identity comes **only** from the `logged_in_customer_id` param Shopify
  itself appends — never from bare query params.
- Logged in → `proxyHandoff(shop, loggedInCustomerId)`: mints a **5-minute**
  single-use token and answers `302` (absolute URL) to
  `PORTAL_BASE_URL/portal/magic/<token>`. The portal cookie cannot be set on
  the proxy response itself — that response is served on the storefront
  domain, and the cookie must live on the app domain. The instant token
  redirect keeps the hand-off invisible to the customer.
- Logged out → `302` to `/portal/login`.
- `POST` with `email` → `requestMagicLink` → friendly JSON (always success).

### Guards used by every route

- `requirePortalCustomer(request)` — redirects to `/portal/login` when the
  session is absent. Every loader/action calls it first.
- `findOwnedContract(customer, contractId)` — THE ownership check: resolves
  the contract by `id + shop + customer identity from the verified session`
  and 404s otherwise. Every mutation resolves its contract through this (or
  `findPrimaryContract`), so tampered form ids can never reach another
  customer's plan. Cancellation sessions are re-verified the same way
  (`session.shop` + owned contract).

## Route map

| Route | Purpose |
| --- | --- |
| `portal.tsx` | Branded layout: wordmark, nav (Dashboard, Next delivery, My routine, Settings), footer with support + "Adjust, delay or cancel online". Loads `app/styles/portal.css`, injects configurable `@font-face` overrides. |
| `portal.login.tsx` | Magic-link request; success state always shown. |
| `portal.magic.$token.tsx` | Verify + session; friendly retry on failure. |
| `portal.logout.tsx` | Destroys the session. |
| `portal._index.tsx` | **The treatment dashboard**: routine cards, next delivery + countdown, supply per product (DepletionEstimate), subscriber savings, treatment week, milestone badges, top-3 recommended additions (offers `rankAddOnCandidates`) with one-click AddOnItem create, four action cards. |
| `portal.delivery.tsx` | Delay chips (+1/+2/+4 weeks), exact date (bring forward vs reschedule), skip with supply context. Core: `delayByWeeks`, `bringForward`, `setNextBillingDate`, `skipNextShipment`. |
| `portal.treatment.tsx` | Quantity steppers, variant swap (server-validated), cadence chips (from SellingPlanConfig), remove (keep-one guard), pause 30/60/90/custom + resume, add-product with mode choice (next only / every / N deliveries / own rhythm). |
| `portal.routine.tsx` | Routine builder: concern → current products → `recommendRoutine` + coherence notes (AM/PM, stagger, order) → subscribe into the fewest shipments (`consolidationPlan` → `mergeContracts` → `addLineToContract`). |
| `portal.manage.tsx` | Address form (`updateDeliveryAddress`), masked card + secure update email (`sendPaymentUpdateEmail`), autopilot toggle + guardrails, merge-shipments suggestion, visible cancel link. |
| `portal.cancel.tsx` | Diagnostic cancel: nine reasons → reason-specific offers (structural first) → accept (`acceptOffer`) with warm confirmation, or `finalizeCancellation` with a graceful goodbye. The final cancel is always reachable within two clicks (plus a visible "cancel right away" on step 1). |
| `proxy.portal-link.tsx` | Storefront entry (above). |

Shared branded components live in `app/components/portal/` (ProductCard,
ActionCard, StatTile, QuantityStepper, DateChips, ConfirmBanner,
MilestoneBadge, OfferCard, WizardSteps) plus `logic.tsx` — the pure,
I/O-free decision/display helpers unit-tested in `tests/portal/auth.test.ts`.

## UX principles (BRAND.md applied)

- **Voice**: "treatment plan", "delivery", "routine" — never subscription
  jargon. Reassure everywhere: "Adjust, delay or cancel online."
- **Calm premium**: white cards on `#F4F4F4`, 1px `#D8D8D8` borders, Gobold
  uppercase headlines, Argumentum body, pill buttons identical to the theme's
  `.btn` (70px radius, 15px 20px, min-height 50px, letter-spacing 1px).
- **No dark patterns**: cancel is visible in Manage and completes in two
  clicks; offers are genuinely useful, structural first; no countdowns, no
  guilt. Benefits accumulate (milestones) rather than pressure.
- **No JS required**: every control is a plain form; the portal works fully
  server-rendered. Focus-visible states and aria labels throughout.
- **Money**: integer cents formatted with `lib/money`; savings derived from
  the signed-up cohort discount (`initialDiscountPercent`), never invented.

## Configuration

| Env | Purpose |
| --- | --- |
| `MAGIC_LINK_SECRET` | Token + cookie signing (required in production). |
| `PORTAL_BASE_URL` | Absolute portal origin (fallback `SHOPIFY_APP_URL`). |
| `PORTAL_SHOP` | Optional: pins the login page's shop for magic links (otherwise `?shop=` param or the single installed shop). |
| `PORTAL_FONT_BASE_URL` | Optional font asset base; `ShopSettings.settingsJson.fontBaseUrl` wins per shop. Default faces point at `/fonts/`; system fallbacks always apply. |
| `PORTAL_SUPPORT_EMAIL` | Footer support address (default `care@cellexia.com`). |

## Integration notes

- **Autopilot**: ARCHITECTURE.md publishes no `treatment/autopilot.server`
  contract, so `portal.manage.tsx` writes `autopilotEnabled` +
  `guardrailsJson` (domain `AutopilotGuardrails`) directly with an audit
  entry — swap for the treatment module's setter once it exists.
- **GraphQL documents**: the two small variant-lookup queries in
  `portal.treatment.tsx` / `portal.routine.tsx` are marked to move into
  `app/graphql/*.ts` [core] when core lands its documents.
- **Defensive adapters**: `normalizeRankedAddOns` / `normalizeRoutineRecommendation`
  keep the dashboard resilient to the exact shapes the offers/treatment
  modules export; suggestions degrade to hidden rather than erroring.
- **Add-on price integrity**: the dashboard never trusts prices from forms —
  the action re-ranks server-side and matches the candidate; the treatment
  route re-fetches the variant price from Shopify.
