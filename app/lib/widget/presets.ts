import { z } from "zod";

/**
 * Buy-box design presets + config schema — ISOMORPHIC (no server imports).
 * The admin Buy box designer UI imports this on the client, and
 * app/lib/widget/design.server.ts imports it on the server.
 *
 * The config is published to the shop metafield cellexia.buybox_design
 * (type json) and read by extensions/cellexia-buy-box with null-safe
 * fallbacks: a shop with no saved config renders EXACTLY as v1.0.0 did.
 * DEFAULT_DESIGN_CONFIG below keeps the v1.0.0 archetype knobs (classic
 * stacked cards, subscription first, dropdown frequency selector, 1px
 * borders); as of v1.2.0 its STYLE tokens are brand-matched to
 * cellexialabs.com (near-black #1D1D1B accents on white, #F4F4F4 panel
 * tint, sharp 0px corners) so the widget looks native there out of the box.
 *
 * Schema evolution rule: every field added after version 1 shipped MUST
 * carry a field-level .default() so older stored revisions (and the
 * published metafield JSON) keep validating unchanged.
 */

// ── Preset keys + CRO metadata ───────────────────────────────────────────────

export const PRESET_KEYS = [
  "classic",
  "toggle",
  "tiles",
  "inline",
  "value_stack",
  "planner",
  "subscription_max",
  "subscription_ultra_max",
] as const;

export type PresetKey = (typeof PRESET_KEYS)[number];

export interface PresetMeta {
  name: string;
  tagline: string;
  croRationale: string;
  conversionRisk: "minimal" | "low" | "medium";
  bestFor: string;
}

/**
 * Honest CRO framing for the admin designer. `conversionRisk` is the risk to
 * overall PDP conversion (not to subscription take-rate): heavier persuasion
 * modules can lift take-rate while costing cold-traffic conversions.
 */
export const PRESET_META: Record<PresetKey, PresetMeta> = {
  classic: {
    name: "Classic cards",
    tagline: "The proven default — stacked full-width option cards.",
    croRationale:
      "The v1.0.0 layout your current conversion rate was measured on. Both " +
      "options get equal visual weight, the subscription card is accented and " +
      "badged. Changing nothing is a valid CRO strategy: this is the baseline " +
      "every other preset should be tested against.",
    conversionRisk: "minimal",
    bestFor: "Your control group — keep it live while you A/B the others.",
  },
  toggle: {
    name: "Toggle tabs",
    tagline: "Segmented one-time / subscribe pill with a detail panel below.",
    croRationale:
      "Collapses the choice into one compact control that reads like a native " +
      "mobile pattern, so it adds almost no page height and no scroll cost. " +
      "The savings percent lives inside the subscribe tab label, making the " +
      "upgrade visible before any interaction. Detail is revealed only for " +
      "the selected option, which reduces comparison friction but also hides " +
      "the side-by-side value story.",
    conversionRisk: "low",
    bestFor: "Mobile-heavy traffic and PDPs that are already long.",
  },
  tiles: {
    name: "Comparison tiles",
    tagline: "Two side-by-side tiles with explicit compare rows.",
    croRationale:
      "Puts the per-delivery price, savings and flexibility rows directly " +
      "against the one-time offer, so the subscription's advantage is argued " +
      "rather than asserted. Side-by-side comparison is the strongest desktop " +
      "pattern for considered purchases, but tiles compress on small screens " +
      "and the extra copy adds cognitive load for impulse buyers.",
    conversionRisk: "low",
    bestFor: "Desktop-heavy traffic and products bought deliberately.",
  },
  inline: {
    name: "Inline upgrade",
    tagline: "One checkbox row under the price — near-zero visual weight.",
    croRationale:
      "The buy box stays exactly as the theme designed it; subscribing is a " +
      "single opt-in line, so there is effectively nothing new to hurt " +
      "conversion. The trade-off is symmetrical: minimal presentation also " +
      "does the least persuasion, so expect the smallest take-rate lift. This " +
      "is the zero-conversion-risk option.",
    conversionRisk: "minimal",
    bestFor: "Stores that will not risk a point of CVR while testing subscriptions.",
  },
  value_stack: {
    name: "Value stack",
    tagline: "Benefit-rich subscription panel; one-time demoted to a text link.",
    croRationale:
      "Maximum persuasion: headline price plus a check-mark benefit list " +
      "(first-order discount, ongoing discount, milestone gift, cancel " +
      "anytime) while the one-time option becomes a quiet escape hatch. " +
      "Highest expected take-rate on warm, high-consideration traffic — but " +
      "demoting one-time purchase is a real conversion risk on cold traffic " +
      "that never intended to subscribe. Measure CVR, not just take-rate.",
    conversionRisk: "medium",
    bestFor: "Warm traffic, replenishable heroes, strong offer architecture.",
  },
  planner: {
    name: "Routine planner",
    tagline: "Frequency-first chips that sell the cadence, not the discount.",
    croRationale:
      "Leads with 'how often do you run out' instead of 'how much off', " +
      "framing the subscription as a routine decision the shopper was already " +
      "making. The recommended-frequency tag anchors the choice and per-" +
      "delivery pricing keeps the number small. Engaging, but the chips ask " +
      "for a decision before purchase, which can stall shoppers who have no " +
      "idea of their usage cadence.",
    conversionRisk: "medium",
    bestFor: "Consumables with a well-understood usage rhythm.",
  },
  subscription_max: {
    name: "Subscription max",
    tagline:
      "The subscription card IS the buy box; one-time becomes a quiet link.",
    croRationale:
      "Highest take-rate posture: one clear way to buy, zero decision " +
      "fatigue. The calm single card carries the price, the ongoing cadence " +
      "line and the skip/pause/cancel reassurance; no badge, no frequency " +
      "selector, no 'choose your option' framing by default. This is NOT " +
      "subscription-only — the one-time purchase stays real, priced and one " +
      "tap away as a quiet underlined link below the card (a compliance " +
      "guardrail that also protects conversion). Purely presentational: it " +
      "implies no extra perks or discounts. Demoting one-time is a real risk " +
      "on cold traffic that never meant to subscribe — watch PDP conversion " +
      "in Design performance against your baseline and restore the previous " +
      "design from history in one click if it dips.",
    conversionRisk: "medium",
    bestFor:
      "Replenishable heroes with warm traffic, where subscribing should " +
      "read as the obvious way to buy.",
  },
  subscription_ultra_max: {
    name: "Subscription ultra max",
    tagline:
      "The subscription reads as the plain, normal way of buying; one-time " +
      "moves below the whole buy area.",
    croRationale:
      "Subscription max taken to its logical end. The card loses every " +
      "piece of offer chrome — no border, no tint, no badge, no savings " +
      "pill, no reassurance line by default — so the subscription price " +
      "reads exactly like the product's price, not like a special plan " +
      "being sold. The recurring cadence line stays visible (recurrence " +
      "disclosure is never optional), and the priced one-time link stays " +
      "one tap away — but relocated below the entire buy area (quantity, " +
      "add to cart, guarantees), where only a shopper actively looking for " +
      "it will find it. Maximum posture means maximum accountability: " +
      "watch PDP conversion AND refund/cancel quality in Design " +
      "performance, not just take-rate — shoppers who did not understand " +
      "they subscribed are expensive.",
    conversionRisk: "medium",
    bestFor:
      "Warm traffic on a hero product where subscription IS the intended " +
      "default and one-time is the exception.",
  },
};

// ── Config schema (version 1) ────────────────────────────────────────────────

const presetEnum = z.enum(PRESET_KEYS);

export const CUSTOM_CSS_MAX_LENGTH = 5000;

/** Strict #rgb / #rrggbb hex color. */
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const hexColor = z
  .string()
  .regex(HEX_COLOR_RE, "must be a hex color like #1d1d1b");

/**
 * Hex color, or "" meaning "inherit" — keep the v1.0.0 behavior for this slot
 * (theme text color, accent-derived tint, accent badge background). Required
 * for the pixel-identical fallback: forcing a concrete hex on these would
 * change rendering on shops that never touched them.
 */
const hexColorOrInherit = z.union([hexColor, z.literal("")]);

/** BCP-47-ish locale keys as used by Shopify: "en", "pt-BR", "zh-Hant". */
const LOCALE_KEY_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const localeKey = z
  .string()
  .regex(LOCALE_KEY_RE, "must be a locale code like \"en\" or \"pt-BR\"");

/**
 * Characters stripped from every merchant-authored CSS selector
 * (`placement.selector`, `themeSync.priceSelector`): a selector is never
 * HTML, so angle brackets, quotes and backslashes have no legitimate use and
 * removing them keeps the value inert wherever it is interpolated
 * (data-attributes in Liquid, querySelector in the storefront JS).
 */
const SELECTOR_UNSAFE_RE = /[<>"'`\\]/g;

/**
 * Sanitize a merchant-authored CSS selector (see SELECTOR_UNSAFE_RE). Used by
 * both selector fields in the config — `placement.selector` (where the app
 * embed mounts) and `themeSync.priceSelector` (which of the theme's elements
 * carry the add-to-cart price).
 */
export function sanitizePlacementSelector(selector: string): string {
  return selector.replace(SELECTOR_UNSAFE_RE, "").trim();
}

const DEFAULT_PLACEMENT = {
  mode: "auto",
  selector: "",
  position: "before",
} as const;

/**
 * Where the APP-EMBED variant of the buy box mounts itself on the product
 * page (the product-page app block, where the theme supports one, always
 * renders exactly where the merchant placed it — this setting is ignored
 * there). Added in v1.2.0 with object- and field-level defaults so every
 * pre-existing stored config still validates.
 *
 * - auto: the embed JS walks a prioritized anchor list tuned for
 *   cellexialabs.com (insert before .pdp__grey — after the size options,
 *   above quantity + add to cart) with generic theme fallbacks.
 * - selector: an explicit CSS selector + relative position for themes where
 *   auto anchoring picks the wrong spot.
 */
const placementSchema = z
  .object({
    mode: z.enum(["auto", "selector"]).default("auto"),
    selector: z
      .string()
      .max(200)
      .default("")
      .transform(sanitizePlacementSelector),
    position: z
      .enum(["before", "after", "prepend", "append"])
      .default("before"),
  })
  .strict()
  .default(DEFAULT_PLACEMENT);

export const PRICE_SELECTOR_MAX_LENGTH = 300;

const DEFAULT_THEME_SYNC = {
  syncAddToCartPrice: true,
  priceSelector: "",
  syncMainPrice: true,
  mainPriceSelector: "",
} as const;

/**
 * Theme integration (v1.2.2) — keeping the THEME's own add-to-cart button
 * honest about the price the shopper actually selected.
 *
 * Most themes print the price inside the button ("ADD TO CART - CHF 64.00").
 * That string is the one-time price, so with the subscription option selected
 * the widget says CHF 51.20 while the button the shopper is about to click
 * still says CHF 64.00 — two prices for one action.
 *
 * `syncAddToCartPrice` lets `assets/buy-box.js` replace the one-time MONEY
 * STRING with the subscription one inside that button's text nodes (never a
 * re-render, never innerHTML, reverted the moment one-time is selected). It
 * is inherently safe: if the button does not contain the exact one-time money
 * string, nothing happens at all.
 *
 * `priceSelector` is the escape hatch for a theme the built-in selector list
 * does not cover (e.g. `.pdp__actions .btn--atc`); "" means "use the built-in
 * list". Sanitized exactly like `placement.selector`.
 *
 * `syncMainPrice` / `mainPriceSelector` (v1.11.0) extend the same swap to the
 * theme's MAIN price display (the price under the product title —
 * `.pdp__price` on cellexialabs.com). Same mechanism, same safety: an exact
 * money-string swap in text nodes, reverted on one-time/hidden/gated, a no-op
 * unless the element literally contains the one-time string. Struck-through
 * compare-at and per-unit strings are deliberately untouched (they are not
 * the one-time money string, and this module never computes money).
 *
 * Added in v1.2.2 (v1.11.0 for the main-price pair) with object- AND
 * field-level defaults, so every stored revision and the live
 * `cellexia.buybox_design` metafield keep validating.
 */
const themeSyncSchema = z
  .object({
    syncAddToCartPrice: z.boolean().default(true),
    priceSelector: z
      .string()
      .max(PRICE_SELECTOR_MAX_LENGTH)
      .default("")
      .transform(sanitizePlacementSelector),
    syncMainPrice: z.boolean().default(true),
    mainPriceSelector: z
      .string()
      .max(PRICE_SELECTOR_MAX_LENGTH)
      .default("")
      .transform(sanitizePlacementSelector),
  })
  .strict()
  .default(DEFAULT_THEME_SYNC);

const textOverrideSchema = z
  .object({
    heading: z.string().max(200).optional(),
    subheading: z.string().max(300).optional(),
    subscribeLabel: z.string().max(200).optional(),
    oneTimeLabel: z.string().max(200).optional(),
    badge: z.string().max(80).optional(),
    /** Supports {percent} / {amount} / {frequency} placeholders. */
    savingsTemplate: z.string().max(200).optional(),
    reassurance: z.string().max(300).optional(),
    benefits: z.array(z.string().max(200)).max(5).optional(),
    frequencyLabel: z.string().max(200).optional(),
    /** Supports {percent} / {amount} / {frequency} placeholders. */
    firstOrderLine: z.string().max(200).optional(),
    /** Supports {percent} / {amount} / {frequency} placeholders. */
    oneTimeLinkLabel: z.string().max(200).optional(),
  })
  .strict();

export const widgetDesignConfigSchema = z
  .object({
    version: z.literal(1),
    preset: presetEnum,
    layout: z
      .object({
        order: z.enum(["sub_first", "one_time_first"]),
        density: z.enum(["comfortable", "compact"]),
        radiusPx: z.number().int().min(0).max(24),
        borderWidthPx: z.number().int().min(1).max(3),
        frequencyStyle: z.enum(["dropdown", "chips"]),
        /**
         * Show the delivery-frequency selector. false removes it from ALL
         * presets (the planner keeps a single recommended-cadence line) and
         * every add-to-cart uses the plan's default frequency; subscribers can
         * still change frequency any time in the portal. Field-level default
         * keeps pre-v1.2.0 stored configs valid.
         */
        showFrequency: z.boolean().default(true),
        showBadge: z.boolean(),
        showSavings: z.boolean(),
        showPerDelivery: z.boolean(),
        showCompareAt: z.boolean(),
        showReassurance: z.boolean(),
        showBenefits: z.boolean(),
        benefitCount: z.number().int().min(0).max(5),
      })
      .strict(),
    style: z
      .object({
        accent: hexColor,
        accentText: hexColor,
        bgTint: hexColorOrInherit,
        text: hexColorOrInherit,
        badgeBg: hexColorOrInherit,
        badgeText: hexColor,
        fontScale: z.number().min(0.85).max(1.15),
        /** Sanitize with sanitizeCustomCss() before save AND before publish. */
        customCss: z.string().max(CUSTOM_CSS_MAX_LENGTH),
      })
      .strict(),
    behavior: z
      .object({
        preselect: z.enum(["inherit", "subscription", "one_time"]),
        animation: z.boolean(),
      })
      .strict(),
    /** App-embed mount point (v1.2.0) — see placementSchema. */
    placement: placementSchema,
    /** Theme add-to-cart price sync (v1.2.2) — see themeSyncSchema. */
    themeSync: themeSyncSchema,
    /** Per-locale overrides; resolution: current locale → "en" → extension locale files. */
    text: z.record(localeKey, textOverrideSchema),
    /**
     * Per-market preset selection (v1.6.0). Keys are Shopify MARKET HANDLES
     * (`localization.market.handle` on the storefront); the value picks the
     * design preset for that market. Everything else — text, layout, style,
     * behavior, placement, themeSync — inherits the base config; `preset`
     * above is the default for every market without an entry. The Liquid
     * resolves nil-safely (older stores / the test harness may not provide
     * `localization.market`) and the forced design_source block setting
     * still wins over both. Field-level .default({}) keeps every stored
     * revision and the live cellexia.buybox_design metafield parsing
     * unchanged (schema evolution rule at the top of this file).
     */
    markets: z
      .record(z.string().max(80), z.object({ preset: presetEnum }).strict())
      .default({}),
  })
  .strict();

export type WidgetDesignConfig = z.infer<typeof widgetDesignConfigSchema>;
export type WidgetDesignLayout = WidgetDesignConfig["layout"];
export type WidgetDesignStyle = WidgetDesignConfig["style"];
export type WidgetDesignBehavior = WidgetDesignConfig["behavior"];
export type WidgetDesignPlacement = WidgetDesignConfig["placement"];
export type WidgetDesignThemeSync = WidgetDesignConfig["themeSync"];
export type WidgetDesignTextOverride = z.infer<typeof textOverrideSchema>;
export type WidgetDesignMarkets = WidgetDesignConfig["markets"];

/**
 * The designer's starting config. Layout/behavior knobs are still the
 * v1.0.0 classic archetype (stacked cards, subscription first, dropdown
 * frequency selector, 1px borders), but as of v1.2.0 the STYLE tokens —
 * accent/text #1D1D1B, panel tint #F4F4F4, white on accent, 0px radius —
 * are brand-matched to cellexialabs.com (monochrome editorial: near-black
 * on white, grey #F4F4F4 panels, sharp corners everywhere but the pill
 * buttons), so publishing untouched already looks native there.
 *
 * The pixel-identical v1.0.0 fallback lives one layer down: a shop with NO
 * published metafield at all keeps the Liquid/CSS built-in defaults, which
 * remain the v1.0.0 rendering.
 */
export const DEFAULT_DESIGN_CONFIG: WidgetDesignConfig = {
  version: 1,
  preset: "classic",
  layout: {
    order: "sub_first",
    density: "comfortable",
    radiusPx: 0,
    borderWidthPx: 1,
    frequencyStyle: "dropdown",
    showFrequency: true,
    showBadge: true,
    showSavings: true,
    showPerDelivery: true,
    showCompareAt: false,
    showReassurance: true,
    showBenefits: false,
    benefitCount: 4,
  },
  style: {
    accent: "#1D1D1B",
    accentText: "#FFFFFF",
    bgTint: "#F4F4F4",
    text: "#1D1D1B",
    badgeBg: "#1D1D1B",
    badgeText: "#FFFFFF",
    fontScale: 1,
    customCss: "",
  },
  behavior: {
    preselect: "inherit",
    animation: true,
  },
  placement: {
    mode: "auto",
    selector: "",
    position: "before",
  },
  themeSync: {
    syncAddToCartPrice: true,
    priceSelector: "",
    syncMainPrice: true,
    mainPriceSelector: "",
  },
  text: {},
  markets: {},
};

// ── customCss sanitizer ──────────────────────────────────────────────────────

/** url(...) whose target starts with a scheme ("http:", "data:", ...). */
const SCHEMED_URL_RE =
  /url\(\s*(['"]?)\s*[a-zA-Z][a-zA-Z0-9+.-]*:[^)]*\)/gi;

/**
 * Server-side custom-CSS sanitizer, applied before save AND before metafield
 * publish. The CSS is injected scoped inside the widget wrapper only
 * (`#cx-buybox-<uid> { … }` in the Liquid), but is still merchant-authored
 * content on the storefront, so: strip `@import`, `expression(`, `url(` with
 * any non-relative scheme, `<`, `>` and `javascript:`; cap at 5000 chars.
 * Stripping loops until stable so removed fragments cannot recompose a
 * banned token (e.g. "@imp@importort").
 *
 * BRACE CONTAINMENT: the wrapper scoping only holds if no `}` in the css can
 * close the wrapper rule itself. A css like `color:red} body{display:none`
 * would escape the wrapper and ship UNSCOPED, storefront-global rules — up
 * to and including hiding the demoted one-time link the subscription_max /
 * value_stack presets keep as a compliance guardrail, or blanking the whole
 * page. So braces must BALANCE: depth may never go negative (an early `}`
 * escapes) and must end at zero (a trailing unclosed `{` would swallow the
 * wrapper's own closing brace). Balanced css — including nested rules under
 * the wrapper id — passes through verbatim; anything unbalanced is rejected
 * WHOLE (returns ""). All-or-nothing on purpose: dropping individual braces
 * would silently turn selectors into declarations with a different meaning,
 * while a rejected css is immediately visible in the designer preview. The
 * check runs after the length cap, so a cap-truncated css that lost its
 * closing braces is rejected rather than shipped half-open. The Liquid belt
 * (cx-buybox-core.liquid) mirrors the same depth walk against hand-edited
 * metafields.
 */
export function sanitizeCustomCss(css: string): string {
  let out = css;
  let prev: string;
  do {
    prev = out;
    out = out
      .replace(/[<>]/g, "")
      .replace(/@import/gi, "")
      .replace(/expression\s*\(/gi, "")
      .replace(/javascript:/gi, "")
      // url() with a scheme: keep only relative/fragment/scheme-less targets.
      .replace(SCHEMED_URL_RE, "url()");
  } while (out !== prev);
  out = out.slice(0, CUSTOM_CSS_MAX_LENGTH);

  let depth = 0;
  for (const ch of out) {
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth < 0) return ""; // a `}` escaped the wrapper rule
    }
  }
  return depth === 0 ? out : "";
}

// ── Text resolution ──────────────────────────────────────────────────────────

type StringTextKey = {
  [K in keyof WidgetDesignTextOverride]-?: WidgetDesignTextOverride[K] extends
    | string
    | undefined
    ? K
    : never;
}[keyof WidgetDesignTextOverride];

/**
 * Resolve one text override: config.text[locale] → config.text[base language]
 * → config.text.en → `fallback` (the extension locale files / current keys).
 * Locale matching is case-tolerant ("pt-BR" matches a "pt-br" key); blank
 * overrides are treated as absent so an empty admin field can never blank out
 * storefront copy.
 */
export function resolveDesignText(
  config: WidgetDesignConfig,
  locale: string,
  key: StringTextKey,
  fallback: string,
): string {
  for (const candidate of localeCandidates(locale)) {
    const entry = lookupLocale(config, candidate);
    const value = entry?.[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return fallback;
}

/** Array variant of resolveDesignText for the benefits list. */
export function resolveDesignBenefits(
  config: WidgetDesignConfig,
  locale: string,
  fallback: string[],
): string[] {
  for (const candidate of localeCandidates(locale)) {
    const benefits = lookupLocale(config, candidate)?.benefits;
    if (benefits && benefits.length > 0) return benefits;
  }
  return fallback;
}

/** Candidate locale keys in resolution order: exact, base language, "en". */
function localeCandidates(locale: string): string[] {
  const normalized = locale.trim();
  const base = normalized.split("-")[0].toLowerCase();
  const candidates = [normalized];
  if (base && base !== normalized) candidates.push(base);
  if (!candidates.some((c) => c.toLowerCase() === "en")) candidates.push("en");
  return candidates;
}

/** Case-tolerant lookup into config.text. */
function lookupLocale(
  config: WidgetDesignConfig,
  locale: string,
): WidgetDesignTextOverride | undefined {
  if (config.text[locale]) return config.text[locale];
  const lower = locale.toLowerCase();
  for (const key of Object.keys(config.text)) {
    if (key.toLowerCase() === lower) return config.text[key];
  }
  return undefined;
}
