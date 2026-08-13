# Cellexia Post-purchase Survey (checkout UI extension)

Four one-tap questions shown to NEW SUBSCRIBERS only (orders with a
selling-plan line) on the Thank You page and the Order Status page. Answers
POST to the app backend (`/api/survey`) with a Shopify session token, attach
to the subscription contract, and feed the churn-risk score, the predicted
LTGP forecast, and the `Cellexia Survey Answered` Klaviyo metric.

## The instrument is frozen

`src/questions.json` mirrors `app/lib/survey/shared.ts` (extension sources
cannot import app code). `tests/survey-instrument.test.ts` pins the two to
exact equality. Never rename, reorder or merge option keys within a
version — answers are only comparable inside one `questionSetVersion`, and
churn/LTGP coefficients are estimated per option key over months of matured
labels. Customer-visible WORDING lives in `locales/` and may be polished per
locale, but a wording change that alters an option's MEANING is an instrument
change and requires a version bump on both sides.

## One-time setup after deploy

1. `npm run deploy` (uploads the extension with the app config).
2. Shopify admin → Settings → Checkout → Customize → **Thank you** page:
   add the "Cellexia Post-purchase Survey" block where it should render and
   set its **App URL** setting to the app host (the `SHOPIFY_APP_URL` value,
   no trailing slash).
3. Repeat in the checkout-and-accounts editor for the **Order status** page.
4. The store must be on the upgraded (extensibility) Thank You / Order Status
   pages — extensions do not render on the legacy pages.

The block renders nothing until App URL is set, nothing on non-subscription
orders, nothing while `Settings → Post-purchase survey → Show the survey` is
off, and a thank-you note instead of questions once an order's survey is
complete (server-checked, so a revisit from another device never re-asks).

## Failure posture

Every network failure renders nothing or quietly stops — the survey must
never degrade an order-confirmation page, and the extension never retries a
failed write (a lost tap is one missing answer, which the analytics side
treats as expected partial data).
