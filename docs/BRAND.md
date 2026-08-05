# Cellexia brand & theme integration reference

Source of truth: `Cellexia Branding Guidelines 2025.pdf` + the live theme in
`existing shopify theme/` (Sleepless Media build, jQuery + CartJS stack).

## Brand tokens

| Token | Value | Use |
| --- | --- | --- |
| `--cx-ink` | `#1D1D1B` | Primary text, primary buttons, headlines |
| `--cx-blue` | `#B2CEED` (theme CSS uses `#B1CDED`) | Signature accent: selected states, highlights, badges. Use the theme's `#B1CDED` in storefront code. |
| `--cx-white` | `#FFFFFF` | Backgrounds |
| `--cx-grey-bg` | `#F4F4F4` | Panel / section backgrounds |
| `--cx-grey-line` | `#D8D8D8` | Borders, dividers |
| `--cx-grey-mid` | `#BABABA` | Muted text, disabled |

Positioning: **scientifically grounded, premium skincare**. Clean, minimal,
plenty of white space. Never busy, never discount-shouty.

## Typography

- **Headlines:** Gobold (already in theme assets: `Gobold.woff2` etc.) — used
  by the theme as `font-family: "Gobold", sans-serif`. Atami is the alternate;
  do not mix the two in one layout. Headlines read best in ALL CAPS.
- **Body / UI:** Argumentum — theme uses `font-family: "argumentum", sans-serif`
  (lowercase name, loaded by the theme). Regular + medium weights.
- Storefront widgets inherit the theme's font-faces automatically. The portal
  (served from the app domain) uses the same stacks with graceful fallbacks:
  `"Gobold", "Arial Black", sans-serif` and `"argumentum", "Helvetica Neue", Arial, sans-serif`,
  and can load the real woff2 files from a configurable asset base URL
  (`ShopSettings.settingsJson.fontBaseUrl`).

## Theme component conventions (match these exactly in storefront widgets)

- Buttons: `.btn` — pill shape (`border-radius: 70px`), `padding: 15px 20px`,
  `min-height: 50px`, `font-size: 14px`, `font-weight: 600`,
  `letter-spacing: 1px`, `text-transform: uppercase`, Argumentum.
  - Primary: ink `#1d1d1b` background, white text, 1px ink border.
  - Secondary: white background, ink text, 1px ink border.
- Cards/panels: white background, `1px solid #d8d8d8`, generous padding;
  section backgrounds `#f4f4f4`.
- Prices: theme displays money via `sm-rc-current-price` style spans; keep
  numerals in Argumentum, bold for emphasized price.

## Existing PDP subscription plumbing (what widgets must be compatible with)

- The theme's PDP (`sections/pdp.liquid`) renders `snippets/sm-rc-widget.liquid`
  which drives selection through attribute hooks: `sm-rc-option{1,2,3}-selector`,
  `sm-rc-variant-selector`, `sm-rc-plan-selector`, `sm-rc-quantity-selector`,
  `sm-rc-add-to-cart`, and display hooks (`sm-rc-current-price`, etc.).
- Adds to cart via `CartJS.addItem(variantId, qty, {selling_plan: <id>})`;
  a plain `POST /cart/add.js` with `items: [{id, quantity, selling_plan}]`
  is equivalent and is what our theme-extension widgets use (no jQuery
  dependency in our code, but must not conflict with the theme's jQuery).
- One-time option only renders when `product.requires_selling_plan` is false.
- Selling plans come from `product.selling_plan_groups`; plan price adjustment
  percentage is available at `selling_plan.price_adjustments[0].value`.

## Customer-facing voice

- The offer is a **Continuous Treatment Plan**, never "subscription" as the
  primary noun in storefront copy ("plan", "treatment", "routine", "delivery").
- Continuous Treatment is the recommended, visually dominant choice; Basic
  Purchase stays visible but secondary.
- Reassurance line always available: "Adjust, delay or cancel online."
- No manipulative countdowns; benefits accumulate (milestones, gifts, price
  protection) rather than pressure.
