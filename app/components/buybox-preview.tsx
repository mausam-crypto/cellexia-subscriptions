/**
 * BuyBoxPreview — pure-React replica of the six storefront buy-box presets,
 * for the admin "Buy box designer" ONLY (never rendered on the storefront).
 *
 * Mirrors extensions/cellexia-buy-box (blocks/buy-box.liquid + buy-box.css):
 * same BEM class names, same CSS custom properties, same text-resolution
 * chain (config.text[locale] → config.text.en → the extension locale-file
 * defaults, approximated here with the English strings). A visually honest
 * approximation is acceptable where Liquid-only details differ — the page
 * carries a footnote telling merchants to confirm with the storefront
 * preview.
 *
 * Dependency-free: no server imports, no Polaris, inline <style> only.
 * Sample product: "Cellexia Renewal Serum", CHF 68.00 one-time (the live
 * shop sells in CHF via Shopify Markets), 20% first-order / 10% ongoing
 * offers, frequencies every 6/8/10/12 weeks, default 8. The surrounding
 * frame (product title, price, add-to-cart pill) is styled after the
 * cellexialabs.com PDP so the v1.2.0 brand-matched defaults read in
 * context.
 *
 * v1.2.0: honors layout.showFrequency=false in all six presets — the
 * frequency control disappears and the planner shows a single
 * recommended-cadence line instead of its chips.
 */
import { useId } from "react";
import {
  DEFAULT_DESIGN_CONFIG,
  resolveDesignBenefits,
  resolveDesignText,
  sanitizeCustomCss,
  type PresetKey,
  type WidgetDesignConfig,
} from "~/lib/widget/presets";

// ── Sample product (fixed for the preview) ────────────────────────────────────

const SAMPLE = {
  title: "Cellexia Renewal Serum",
  /** CHF 68.00 one-time — Shopify Markets renders CHF like "CHF 64.00". */
  oneTime: "CHF 68.00",
  /** 20% first-order discount → CHF 54.40. */
  first: "CHF 54.40",
  /** 10% ongoing discount → CHF 61.20 per renewal/delivery. */
  ongoing: "CHF 61.20",
  percent: "20%",
  frequenciesWeeks: [6, 8, 10, 12],
  defaultWeeks: 8,
};

const SAMPLE_FREQ = `${SAMPLE.defaultWeeks} weeks`;
/** Localized fallbacks (extension en.default.json equivalents). */
const EN = {
  heading: "Choose your ritual", // block setting default
  subscribeSave: "Subscribe & Save",
  subscribeSavePercent: "Subscribe & save {percent}",
  oneTime: "One-time purchase",
  oneTimeShort: "One-time",
  mostPopular: "Most popular",
  deliveryEvery: "Delivery every",
  savePercent: `Save ${SAMPLE.percent}`, // savings_format default "percent"
  then: `then ${SAMPLE.ongoing} every ${SAMPLE_FREQ}`,
  reassurance: "Skip, pause or cancel anytime.",
  firstOrder: "First order",
  perDelivery: "per delivery",
  orBuyOnce: "or buy once for {amount}",
  recommended: "Recommended",
  frequencyLabel: "How often do you need it?",
  tileSavings: "Savings",
  tileFlexibility: "Flexibility",
  benefitFlexibility: "Skip, pause or cancel anytime",
  benefits: [
    "Extra welcome saving on your first order",
    "Ongoing savings on every delivery",
    "A complimentary gift as your ritual grows",
    "Skip, pause or cancel anytime",
  ],
};

/** Resolve the {percent}/{amount}/{frequency} placeholders (cx-tpl.liquid). */
function fillTemplate(tpl: string): string {
  return tpl
    .replaceAll("{percent}", SAMPLE.percent)
    .replaceAll("{amount}", SAMPLE.oneTime)
    .replaceAll("{frequency}", SAMPLE_FREQ);
}

/** #rgb / #rrggbb → rgba(...) at the given alpha (accent-soft derivation). */
function hexToRgba(hex: string, alpha: number): string {
  const raw = hex.replace("#", "");
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  const n = Number.parseInt(full, 16);
  if (Number.isNaN(n) || full.length !== 6) {
    // Invalid hex (mid-typing in the designer): fall back to the brand
    // accent #1D1D1B so the tint stays plausible.
    return `rgba(29, 29, 27, ${alpha})`;
  }
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface BuyBoxPreviewProps {
  /** Draft config to render; defaults to the v1.0.0 default config. */
  config?: WidgetDesignConfig;
  /** Force a preset (gallery thumbnails) without mutating the config. */
  preset?: PresetKey;
  /** Locale used for config.text resolution (default "en"). */
  locale?: string;
  /** Which purchase state to show; defaults to behavior.preselect. */
  selected?: "subscription" | "one_time";
  /** Mini non-interactive thumbnail for the preset gallery. */
  compact?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function BuyBoxPreview({
  config,
  preset,
  locale = "en",
  selected,
  compact = false,
}: BuyBoxPreviewProps) {
  const rawId = useId();
  const domId = `cx-preview-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const base = config ?? DEFAULT_DESIGN_CONFIG;
  const cfg: WidgetDesignConfig =
    preset && preset !== base.preset ? { ...base, preset } : base;
  const { layout, style, behavior } = cfg;

  const isSub =
    (selected ?? (behavior.preselect === "one_time" ? "one_time" : "subscription")) ===
    "subscription";

  // ── Text resolution (config.text[locale] → en → English defaults) ──────────
  const txt = (
    key: Parameters<typeof resolveDesignText>[2],
    fallback: string,
  ) => fillTemplate(resolveDesignText(cfg, locale, key, fallback));

  const heading = txt("heading", EN.heading);
  const subheading = txt("subheading", "");
  const subLabel = txt(
    "subscribeLabel",
    cfg.preset === "toggle" || cfg.preset === "inline"
      ? EN.subscribeSavePercent
      : EN.subscribeSave,
  );
  const oneTimeLabel = txt("oneTimeLabel", EN.oneTime);
  const oneTimeLabelShort = txt("oneTimeLabel", EN.oneTimeShort);
  const badge = txt("badge", EN.mostPopular);
  const saveStr = txt("savingsTemplate", EN.savePercent);
  const reassurance = txt("reassurance", EN.reassurance);
  const freqLabel = txt(
    "frequencyLabel",
    cfg.preset === "planner" ? EN.frequencyLabel : EN.deliveryEvery,
  );
  const firstLine = txt("firstOrderLine", EN.firstOrder);
  const oneTimeLink = txt("oneTimeLinkLabel", EN.orBuyOnce);
  const benefits = resolveDesignBenefits(cfg, locale, EN.benefits)
    .map(fillTemplate)
    .slice(0, Math.max(0, layout.benefitCount));
  // value_stack IS the benefit panel — mirror the Liquid archetype override.
  const showBenefits = cfg.preset === "value_stack" || layout.showBenefits;
  const stackBenefits =
    benefits.length > 0
      ? benefits
      : EN.benefits.slice(0, 4); // value_stack floor (benefitCount < 1 → 4)

  // ── Style vars (identical custom-property contract to the Liquid block) ─────
  const styleVars: Record<string, string> = {
    "--cx-accent": style.accent,
    "--cx-accent-soft": style.bgTint || hexToRgba(style.accent, 0.07),
    "--cx-accent-text": style.accentText,
    "--cx-badge-text": style.badgeText,
    "--cx-font-scale": String(style.fontScale),
    "--cx-radius": `${layout.radiusPx}px`,
    "--cx-border-width": `${layout.borderWidthPx}px`,
  };
  if (style.text) styleVars["--cx-text"] = style.text;
  if (style.badgeBg) styleVars["--cx-badge-bg"] = style.badgeBg;

  const customCss = sanitizeCustomCss(style.customCss ?? "");

  const wrapperClass = [
    "cx-buybox",
    `cx-buybox--${cfg.preset}`,
    layout.density === "compact" ? "cx-buybox--compact" : "",
    behavior.animation ? "" : "cx-buybox--no-anim",
  ]
    .filter(Boolean)
    .join(" ");

  // ── Shared fragments ────────────────────────────────────────────────────────

  const check = (
    <svg
      className="cx-buybox__check"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6.5 11.3 3.4 8.2l1-1 2.1 2 5-5.1 1 1z" fill="currentColor" />
    </svg>
  );

  const control = (checked: boolean) => (
    <span
      className={`cx-buybox__control${checked ? " is-checked" : ""}`}
      aria-hidden="true"
    />
  );

  const savings = layout.showSavings ? (
    <span className="cx-buybox__save">{saveStr}</span>
  ) : null;

  const priceBlock = (opts: { large?: boolean; showPd?: boolean }) => (
    <>
      <span className="cx-buybox__price-row">
        <span
          className={`cx-buybox__price${opts.large === false ? "" : " cx-buybox__price--lg"}`}
        >
          {SAMPLE.first}
          {layout.showCompareAt ? (
            <s className="cx-price__compare">{SAMPLE.oneTime}</s>
          ) : null}
        </span>
        <span className="cx-buybox__first-label">{firstLine}</span>
      </span>
      <span className="cx-buybox__then">{EN.then}</span>
      {opts.showPd !== false && layout.showPerDelivery ? (
        <span className="cx-buybox__per-delivery">
          {SAMPLE.ongoing} {EN.perDelivery}
        </span>
      ) : null}
    </>
  );

  const freqDropdown = (
    <span className="cx-buybox__freq">
      <span className="cx-buybox__freq-select">
        {EN.deliveryEvery} {SAMPLE.defaultWeeks} weeks
      </span>
    </span>
  );

  const freqChips = (withRecommended: boolean) => (
    <span className="cx-buybox__chips">
      {SAMPLE.frequenciesWeeks.map((w) => (
        <span className="cx-buybox__chip" key={w}>
          <span
            className={`cx-buybox__chip-label${w === SAMPLE.defaultWeeks ? " is-checked" : ""}`}
          >
            {w} weeks
            {withRecommended && w === SAMPLE.defaultWeeks ? (
              <span className="cx-buybox__chip-tag">{EN.recommended}</span>
            ) : null}
          </span>
        </span>
      ))}
    </span>
  );

  // showFrequency=false removes the control from every preset — the plan's
  // default frequency applies (the "then …" line still names the cadence).
  const freqControl = layout.showFrequency
    ? layout.frequencyStyle === "chips"
      ? freqChips(false)
      : freqDropdown
    : null;

  /** Planner without chips: a single recommended-cadence statement. */
  const plannerCadenceLine = (
    <p className="cx-buybox__planner-cadence">
      {EN.deliveryEvery} {SAMPLE_FREQ}
      <span className="cx-buybox__chip-tag">{EN.recommended}</span>
    </p>
  );

  const benefitList = (items: string[]) =>
    items.length > 0 ? (
      <ul className="cx-buybox__benefits">
        {items.map((b, i) => (
          <li className="cx-buybox__benefit" key={i}>
            {check}
            {b}
          </li>
        ))}
      </ul>
    ) : null;

  const reassuranceLine = layout.showReassurance ? (
    <p className="cx-buybox__reassurance">
      {check}
      {reassurance}
    </p>
  ) : null;

  const badgePill =
    layout.showBadge && badge ? (
      <span className="cx-buybox__badge">{badge}</span>
    ) : null;

  // ── Preset bodies ───────────────────────────────────────────────────────────

  const classicSub = (
    <div
      key="sub"
      className={`cx-buybox__option cx-buybox__option--sub${isSub ? " is-selected" : ""}`}
    >
      {badgePill}
      <span className="cx-buybox__card">
        <span className="cx-buybox__card-body">
          {control(isSub)}
          <span className="cx-buybox__card-main">
            <span className="cx-buybox__title-row">
              <span className="cx-buybox__title">{subLabel}</span>
              {savings}
            </span>
            {priceBlock({})}
          </span>
        </span>
      </span>
      {freqControl}
      {reassuranceLine}
      {showBenefits ? benefitList(benefits) : null}
    </div>
  );

  const classicOne = (
    <div
      key="one"
      className={`cx-buybox__option cx-buybox__option--onetime${!isSub ? " is-selected" : ""}`}
    >
      <span className="cx-buybox__card">
        <span className="cx-buybox__card-body">
          {control(!isSub)}
          <span className="cx-buybox__card-main">
            <span className="cx-buybox__title-row">
              <span className="cx-buybox__title">{oneTimeLabel}</span>
              <span className="cx-buybox__price">{SAMPLE.oneTime}</span>
            </span>
          </span>
        </span>
      </span>
    </div>
  );

  const orderPair = (sub: React.ReactNode, one: React.ReactNode) =>
    layout.order === "one_time_first" ? [one, sub] : [sub, one];

  let body: React.ReactNode;

  switch (cfg.preset) {
    case "toggle": {
      const tabSub = (
        <span
          key="tab-sub"
          className={`cx-buybox__tab${isSub ? " is-active" : ""}`}
        >
          {subLabel}
        </span>
      );
      const tabOne = (
        <span
          key="tab-one"
          className={`cx-buybox__tab${!isSub ? " is-active" : ""}`}
        >
          {oneTimeLabelShort}
        </span>
      );
      body = (
        <div className="cx-buybox__group cx-buybox__group--toggle">
          <div className="cx-buybox__tabs">{orderPair(tabSub, tabOne)}</div>
          {isSub ? (
            <div className="cx-buybox__panel cx-buybox__option--sub">
              {savings}
              {priceBlock({})}
              {freqControl}
              {showBenefits ? benefitList(benefits) : null}
              {reassuranceLine}
            </div>
          ) : (
            <div className="cx-buybox__panel">
              <span className="cx-buybox__title-row">
                <span className="cx-buybox__title">{oneTimeLabel}</span>
                <span className="cx-buybox__price">{SAMPLE.oneTime}</span>
              </span>
            </div>
          )}
        </div>
      );
      break;
    }

    case "tiles": {
      const tileSub = (
        <div
          key="sub"
          className={`cx-buybox__option cx-buybox__tile cx-buybox__option--sub${isSub ? " is-selected" : ""}`}
        >
          {badgePill}
          <span className="cx-buybox__card cx-buybox__card--tile">
            <span className="cx-buybox__card-body cx-buybox__card-body--stack">
              <span className="cx-buybox__card-main">
                <span className="cx-buybox__title">{subLabel}</span>
                {priceBlock({ showPd: false })}
                <span className="cx-buybox__rows">
                  <span className="cx-buybox__row">
                    <span className="cx-buybox__row-label">
                      {EN.perDelivery}
                    </span>
                    <span className="cx-buybox__row-value">
                      {SAMPLE.ongoing}
                    </span>
                  </span>
                  {layout.showSavings ? (
                    <span className="cx-buybox__row">
                      <span className="cx-buybox__row-label">
                        {EN.tileSavings}
                      </span>
                      <span className="cx-buybox__row-value cx-buybox__row-value--accent">
                        {saveStr}
                      </span>
                    </span>
                  ) : null}
                  <span className="cx-buybox__row">
                    <span className="cx-buybox__row-label">
                      {EN.tileFlexibility}
                    </span>
                    <span className="cx-buybox__row-value">
                      {EN.benefitFlexibility}
                    </span>
                  </span>
                </span>
              </span>
            </span>
          </span>
          {freqControl}
          {showBenefits ? benefitList(benefits) : null}
          {reassuranceLine}
        </div>
      );
      const tileOne = (
        <div
          key="one"
          className={`cx-buybox__option cx-buybox__tile${!isSub ? " is-selected" : ""}`}
        >
          <span className="cx-buybox__card cx-buybox__card--tile">
            <span className="cx-buybox__card-body cx-buybox__card-body--stack">
              <span className="cx-buybox__card-main">
                <span className="cx-buybox__title">{oneTimeLabel}</span>
                <span className="cx-buybox__price-row">
                  <span className="cx-buybox__price cx-buybox__price--lg">
                    {SAMPLE.oneTime}
                  </span>
                </span>
              </span>
            </span>
          </span>
        </div>
      );
      body = (
        <div className="cx-buybox__group cx-buybox__tiles">
          {orderPair(tileSub, tileOne)}
        </div>
      );
      break;
    }

    case "inline": {
      body = (
        <div className="cx-buybox__group cx-buybox__group--inline">
          <span
            className={`cx-buybox__inline-row${isSub ? " is-selected" : ""}`}
          >
            <input
              type="checkbox"
              className="cx-buybox__inline-box"
              checked={isSub}
              readOnly
              tabIndex={-1}
              aria-hidden="true"
            />
            <span className="cx-buybox__inline-label">{subLabel}</span>
          </span>
          {isSub ? (
            <div className="cx-buybox__inline-detail">
              <span className="cx-buybox__price-row">
                <span className="cx-buybox__price">
                  {SAMPLE.first}
                  {layout.showCompareAt ? (
                    <s className="cx-price__compare">{SAMPLE.oneTime}</s>
                  ) : null}
                </span>
                <span className="cx-buybox__first-label">{firstLine}</span>
              </span>
              <span className="cx-buybox__then">{EN.then}</span>
              {layout.showPerDelivery ? (
                <span className="cx-buybox__per-delivery">
                  {SAMPLE.ongoing} {EN.perDelivery}
                </span>
              ) : null}
              {freqControl}
              {reassuranceLine}
            </div>
          ) : null}
        </div>
      );
      break;
    }

    case "value_stack": {
      body = (
        <div className="cx-buybox__group cx-buybox__group--stack">
          <div
            className={`cx-buybox__option cx-buybox__option--sub cx-buybox__stack-panel${isSub ? " is-selected" : ""}`}
          >
            {badgePill}
            <span className="cx-buybox__card">
              <span className="cx-buybox__card-body cx-buybox__card-body--stack">
                <span className="cx-buybox__card-main">
                  <span className="cx-buybox__title-row">
                    <span className="cx-buybox__title">{subLabel}</span>
                    {savings}
                  </span>
                  {priceBlock({})}
                </span>
              </span>
            </span>
            {benefitList(stackBenefits)}
            {freqControl}
          </div>
          <span
            className={`cx-buybox__stack-onetime${!isSub ? " is-selected" : ""}`}
          >
            <span className="cx-buybox__stack-onetime-link">{oneTimeLink}</span>
          </span>
        </div>
      );
      break;
    }

    case "planner": {
      const plannerSub = (
        <div
          key="sub"
          className={`cx-buybox__option cx-buybox__option--sub${isSub ? " is-selected" : ""}`}
        >
          {badgePill}
          <span className="cx-buybox__card">
            <span className="cx-buybox__card-body">
              {control(isSub)}
              <span className="cx-buybox__card-main">
                <span className="cx-buybox__title-row">
                  <span className="cx-buybox__title">{subLabel}</span>
                  {savings}
                </span>
                <span className="cx-buybox__price-row">
                  <span className="cx-buybox__price cx-buybox__price--lg">
                    {SAMPLE.first}
                  </span>
                  <span className="cx-buybox__first-label">
                    {EN.perDelivery}
                  </span>
                </span>
                <span className="cx-buybox__then">{EN.then}</span>
              </span>
            </span>
          </span>
          {showBenefits ? benefitList(benefits) : null}
          {reassuranceLine}
        </div>
      );
      const plannerOne = (
        <div
          key="one"
          className={`cx-buybox__option cx-buybox__planner-onetime${!isSub ? " is-selected" : ""}`}
        >
          <span className="cx-buybox__card cx-buybox__card--slim">
            <span className="cx-buybox__card-body">
              {control(!isSub)}
              <span className="cx-buybox__card-main">
                <span className="cx-buybox__title-row">
                  <span className="cx-buybox__title">{oneTimeLabel}</span>
                  <span className="cx-buybox__price">{SAMPLE.oneTime}</span>
                </span>
              </span>
            </span>
          </span>
        </div>
      );
      body = (
        <div className="cx-buybox__group cx-buybox__group--planner">
          {layout.showFrequency ? (
            <>
              <p className="cx-buybox__planner-label">{freqLabel}</p>
              {freqChips(true)}
            </>
          ) : (
            plannerCadenceLine
          )}
          <div className="cx-buybox__planner-options">
            {orderPair(plannerSub, plannerOne)}
          </div>
        </div>
      );
      break;
    }

    default: {
      // classic — the v1.0.0 stacked cards.
      body = (
        <div className="cx-buybox__group">
          {orderPair(classicSub, classicOne)}
        </div>
      );
    }
  }

  const widget = (
    <div className="cx-prev-frame">
      <style dangerouslySetInnerHTML={{ __html: PREVIEW_CSS }} />
      {customCss ? (
        <style
          dangerouslySetInnerHTML={{ __html: `#${domId} { ${customCss} }` }}
        />
      ) : null}
      {!compact ? (
        <div className="cx-prev-context">
          <div className="cx-prev-context__title">{SAMPLE.title}</div>
          <div className="cx-prev-context__price">{SAMPLE.oneTime}</div>
        </div>
      ) : null}
      <div id={domId} className={wrapperClass} style={styleVars}>
        {heading ? <h3 className="cx-buybox__heading">{heading}</h3> : null}
        {subheading ? (
          <p className="cx-buybox__subheading">{subheading}</p>
        ) : null}
        {body}
      </div>
      {!compact ? <div className="cx-prev-atc">Add to cart</div> : null}
    </div>
  );

  if (compact) {
    return (
      <div className="cx-prev-thumb" aria-hidden="true">
        <div className="cx-prev-thumb__inner">{widget}</div>
      </div>
    );
  }

  return widget;
}

// ── Preview stylesheet ────────────────────────────────────────────────────────
// A faithful, admin-scoped copy of extensions/cellexia-buy-box/assets/
// buy-box.css. Differences: input-state selectors become .is-checked /
// .is-active / .is-selected classes (the preview is non-interactive), the
// viewport media queries become container queries so the page's
// desktop/mobile width toggle behaves like a real viewport, and the
// focus/gating/noscript rules are dropped (preview only).
//
// The .cx-prev-* frame is preview-only chrome, styled after the
// cellexialabs.com PDP buy column (light editorial sans, near-black
// #1D1D1B, pill UPPERCASE add-to-cart) so the brand-matched defaults are
// judged in a realistic context. The real widget inherits the theme font
// (font-family: inherit) — a generic light sans stands in for "argumentum"
// here.

const PREVIEW_CSS = `
.cx-prev-frame {
  container-type: inline-size;
  font-family: "Helvetica Neue", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-weight: 300;
  color: #1d1d1b;
}

.cx-prev-context__title {
  font-size: 1rem;
  font-weight: 300;
  letter-spacing: 0.01em;
}

.cx-prev-context__price {
  margin-top: 0.15rem;
  font-size: 1rem;
  font-variant-numeric: tabular-nums;
}

.cx-prev-atc {
  margin-top: 0.25rem;
  padding: 15px 20px;
  border-radius: 70px;
  background: #1d1d1b;
  color: #ffffff;
  font-weight: 500;
  font-size: 14px;
  letter-spacing: 1px;
  text-transform: uppercase;
  text-align: center;
  opacity: 0.85;
}

.cx-prev-thumb {
  height: 168px;
  overflow: hidden;
  pointer-events: none;
  border-radius: 8px;
}

.cx-prev-thumb__inner {
  width: 400px;
  transform: scale(0.58);
  transform-origin: top left;
}

.cx-buybox {
  --cx-accent: #4a5d4a;
  --cx-accent-soft: rgba(74, 93, 74, 0.07);
  --cx-border: rgba(0, 0, 0, 0.16);
  --cx-bg: transparent;
  --cx-text: inherit;
  --cx-muted: rgba(0, 0, 0, 0.55);
  --cx-badge-text: #ffffff;
  --cx-radius: 12px;

  margin-block: 1rem;
  color: var(--cx-text);
  font-size: calc(0.9375rem * var(--cx-font-scale, 1));
  line-height: 1.45;
}

.cx-buybox__heading {
  margin: 0 0 0.75rem;
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.cx-buybox__subheading {
  margin: -0.4rem 0 0.75rem;
  font-size: 0.875em;
  color: var(--cx-muted);
}

.cx-buybox__group {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding-block-start: 0.55em;
}

.cx-buybox__option {
  position: relative;
  border: var(--cx-border-width, 1px) solid var(--cx-border);
  border-radius: var(--cx-radius);
  background: var(--cx-bg);
  transition: border-color 0.15s ease, box-shadow 0.15s ease,
    background-color 0.15s ease;
}

.cx-buybox__option--sub {
  border-color: var(--cx-accent);
  background: var(--cx-accent-soft);
}

.cx-buybox__option.is-selected {
  box-shadow: 0 0 0 1px var(--cx-border) inset;
}

.cx-buybox__option--sub.is-selected {
  box-shadow: 0 0 0 1px var(--cx-accent) inset;
}

.cx-buybox__card {
  display: block;
  min-height: 44px;
  padding: 0.875rem 1rem;
  cursor: default;
}

.cx-buybox__card-body {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
}

.cx-buybox__card-main {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  flex: 1 1 auto;
  min-width: 0;
}

.cx-buybox__control {
  flex: 0 0 auto;
  inline-size: 20px;
  block-size: 20px;
  margin-block-start: 0.1em;
  border: 2px solid var(--cx-border);
  border-radius: 50%;
  position: relative;
}

.cx-buybox__control::after {
  content: "";
  position: absolute;
  inset: 3px;
  border-radius: 50%;
  background: var(--cx-accent);
  opacity: 0;
  transform: scale(0.5);
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.cx-buybox__control.is-checked {
  border-color: var(--cx-accent);
}

.cx-buybox__control.is-checked::after {
  opacity: 1;
  transform: scale(1);
}

.cx-buybox__title-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.cx-buybox__title {
  font-weight: 600;
}

.cx-buybox__save {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--cx-accent);
  white-space: nowrap;
}

.cx-buybox__price-row {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.cx-buybox__price {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.cx-buybox__price--lg {
  font-size: 1.375rem;
  line-height: 1.2;
}

.cx-buybox__first-label {
  font-size: 0.8125rem;
  color: var(--cx-muted);
}

.cx-buybox__then,
.cx-buybox__per-delivery {
  font-size: 0.8125rem;
  color: var(--cx-muted);
}

.cx-price__compare {
  color: var(--cx-muted);
  font-weight: 400;
  margin-inline-start: 0.35em;
}

.cx-buybox__freq {
  display: block;
  padding: 0 1rem 0.875rem;
}

.cx-buybox__freq-select {
  display: block;
  inline-size: 100%;
  box-sizing: border-box;
  min-height: 44px;
  padding: 0.6rem 2.25rem 0.5rem 0.75rem;
  font: inherit;
  color: inherit;
  border: 1px solid var(--cx-border);
  border-radius: calc(var(--cx-radius) - 4px);
  background-color: #ffffff;
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5 6 6.5 11 1.5' fill='none' stroke='%23555555' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 0.75rem center;
}

.cx-buybox__badge {
  position: absolute;
  inset-block-start: -0.7em;
  inset-inline-start: 1rem;
  z-index: 1;
  padding: 0.15em 0.7em;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--cx-badge-text);
  background: var(--cx-badge-bg, var(--cx-accent));
  border-radius: 999px;
  white-space: nowrap;
}

.cx-buybox__reassurance {
  display: flex;
  align-items: center;
  gap: 0.4em;
  margin: 0;
  padding: 0 1rem 0.875rem;
  font-size: 0.8125rem;
  color: var(--cx-muted);
}

.cx-buybox__check {
  flex: 0 0 auto;
  color: var(--cx-accent);
}

.cx-buybox--compact {
  font-size: calc(0.875rem * var(--cx-font-scale, 1));
}

.cx-buybox--compact .cx-buybox__group {
  gap: 0.5rem;
}

.cx-buybox--compact .cx-buybox__card {
  padding: 0.625rem 0.875rem;
}

.cx-buybox--compact .cx-buybox__price--lg {
  font-size: 1.125rem;
}

.cx-buybox--compact .cx-buybox__freq,
.cx-buybox--compact .cx-buybox__reassurance {
  padding: 0 0.875rem 0.625rem;
}

@container (min-width: 750px) {
  .cx-buybox:not(.cx-buybox--compact) .cx-buybox__card {
    padding: 1rem 1.25rem;
  }

  .cx-buybox:not(.cx-buybox--compact) .cx-buybox__freq,
  .cx-buybox:not(.cx-buybox--compact) .cx-buybox__reassurance {
    padding: 0 1.25rem 1rem;
  }

  .cx-buybox:not(.cx-buybox--compact) .cx-buybox__badge {
    inset-inline-start: 1.25rem;
  }
}

.cx-buybox__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0;
  padding: 0 1rem 0.875rem;
  border: 0;
}

.cx-buybox__chip-label {
  display: inline-flex;
  align-items: center;
  gap: 0.45em;
  min-height: 40px;
  padding: 0.35rem 0.85rem;
  border: var(--cx-border-width, 1px) solid var(--cx-border);
  border-radius: 999px;
  background: var(--cx-bg);
  font-size: 0.875em;
}

.cx-buybox__chip-label.is-checked {
  border-color: var(--cx-accent);
  background: var(--cx-accent-soft);
  font-weight: 600;
  box-shadow: 0 0 0 1px var(--cx-accent) inset;
}

.cx-buybox__chip-tag {
  display: inline-flex;
  padding: 0.1em 0.55em;
  font-size: 0.72em;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--cx-badge-text);
  background: var(--cx-badge-bg, var(--cx-accent));
  border-radius: 999px;
  white-space: nowrap;
}

.cx-buybox__group--planner .cx-buybox__chips {
  padding: 0 0 0.75rem;
}

.cx-buybox__benefits {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  list-style: none;
  margin: 0;
  padding: 0.25rem 1rem 0.875rem;
  font-size: 0.875em;
}

.cx-buybox__benefit {
  display: flex;
  align-items: flex-start;
  gap: 0.45em;
}

.cx-buybox__benefit .cx-buybox__check {
  margin-block-start: 0.2em;
}

.cx-buybox__rows {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin-block-start: 0.5rem;
  padding-block-start: 0.5rem;
  border-block-start: 1px dashed var(--cx-border);
  font-size: 0.8125em;
}

.cx-buybox__row {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
}

.cx-buybox__row-label {
  color: var(--cx-muted);
}

.cx-buybox__row-value {
  text-align: end;
  font-variant-numeric: tabular-nums;
}

.cx-buybox__row-value--accent {
  color: var(--cx-accent);
  font-weight: 600;
}

.cx-buybox__tabs {
  display: flex;
  gap: 2px;
  padding: 3px;
  border: var(--cx-border-width, 1px) solid var(--cx-border);
  border-radius: 999px;
  background: var(--cx-bg);
}

.cx-buybox__tab {
  flex: 1 1 0;
  min-height: 44px;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem 0.75rem;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 600;
  text-align: center;
}

.cx-buybox__tab.is-active {
  background: var(--cx-accent);
  color: var(--cx-accent-text, #ffffff);
}

.cx-buybox__panel {
  padding: 0.875rem 1rem;
  border: var(--cx-border-width, 1px) solid var(--cx-border);
  border-radius: var(--cx-radius);
  background: var(--cx-bg);
}

.cx-buybox__panel.cx-buybox__option--sub {
  border-color: var(--cx-accent);
  background: var(--cx-accent-soft);
}

.cx-buybox__panel .cx-buybox__save {
  display: block;
  margin-block-end: 0.25rem;
}

.cx-buybox__panel .cx-buybox__freq,
.cx-buybox__panel .cx-buybox__reassurance,
.cx-buybox__panel .cx-buybox__benefits {
  padding-inline: 0;
}

.cx-buybox__panel .cx-buybox__freq,
.cx-buybox__panel .cx-buybox__reassurance,
.cx-buybox__panel .cx-buybox__benefits {
  padding-block: 0.6rem 0;
}

.cx-buybox__tiles {
  display: grid;
  grid-template-columns: 1fr;
  align-items: stretch;
}

@container (min-width: 480px) {
  .cx-buybox__tiles {
    grid-template-columns: 1fr 1fr;
  }
}

.cx-buybox__tile {
  display: flex;
  flex-direction: column;
}

.cx-buybox--tiles .cx-buybox__option--sub {
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.08);
}

.cx-buybox--tiles .cx-buybox__option--sub.is-selected {
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.08), 0 0 0 1px var(--cx-accent) inset;
}

.cx-buybox__card--tile {
  flex: 1 1 auto;
}

.cx-buybox__card-body--stack {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.cx-buybox--inline {
  margin-block: 0.5rem;
}

.cx-buybox__inline-row {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  min-height: 44px;
  padding: 0.35rem 0;
}

.cx-buybox__inline-box {
  flex: 0 0 auto;
  inline-size: 18px;
  block-size: 18px;
  margin: 0.15em 0 0;
  accent-color: var(--cx-accent);
  pointer-events: none;
}

.cx-buybox__inline-label {
  font-weight: 600;
}

.cx-buybox__inline-detail {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding-inline-start: calc(18px + 0.6rem);
}

.cx-buybox__inline-detail .cx-buybox__freq,
.cx-buybox__inline-detail .cx-buybox__reassurance,
.cx-buybox__inline-detail .cx-buybox__chips {
  padding: 0.4rem 0 0;
}

.cx-buybox__stack-panel .cx-buybox__benefits {
  padding-block-start: 0;
}

.cx-buybox__stack-onetime {
  display: block;
  padding: 0.6rem 1rem;
  text-align: center;
}

.cx-buybox__stack-onetime-link {
  font-size: 0.875em;
  color: var(--cx-muted);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.cx-buybox__stack-onetime.is-selected .cx-buybox__stack-onetime-link {
  color: inherit;
  font-weight: 600;
}

.cx-buybox__planner-label {
  margin: 0 0 0.5rem;
  font-size: 0.875em;
  font-weight: 600;
}

/* showFrequency=false: the planner's single recommended-cadence line. */
.cx-buybox__planner-cadence {
  display: flex;
  align-items: center;
  gap: 0.5em;
  margin: 0;
  font-size: 0.875em;
  font-weight: 600;
}

.cx-buybox__planner-options {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding-block-start: 0.55em;
}

.cx-buybox__planner-onetime .cx-buybox__card--slim {
  padding-block: 0.625rem;
}

.cx-buybox--compact .cx-buybox__panel {
  padding: 0.625rem 0.875rem;
}

.cx-buybox--compact .cx-buybox__chips,
.cx-buybox--compact .cx-buybox__benefits {
  padding-block-end: 0.625rem;
}

.cx-buybox--compact .cx-buybox__chip-label {
  min-height: 34px;
  padding: 0.25rem 0.7rem;
}

.cx-buybox--compact .cx-buybox__tab {
  min-height: 38px;
}

.cx-buybox--no-anim *,
.cx-buybox--no-anim *::before,
.cx-buybox--no-anim *::after {
  transition: none !important;
  animation: none !important;
}
`;
