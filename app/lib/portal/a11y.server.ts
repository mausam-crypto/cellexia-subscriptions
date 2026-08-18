import { PORTAL_TOKENS, portalPage } from "~/lib/portal/layout.server";

/**
 * Portal accessibility self-audit (v1.28.0, P5.3).
 *
 * Static, in-process checks over the portal shell — the same tokens and
 * markup `portalPage` serves — so a token edit or a dropped attribute
 * surfaces on the debug page (`portal_a11y` self-check) and in
 * tests/portal-a11y.test.ts, not in a customer's screen reader. Nothing here
 * touches the network or the database.
 *
 * Contrast math is WCAG 2.x relative luminance (sRGB linearisation) and the
 * (L1 + 0.05) / (L2 + 0.05) ratio; AA for body-size text is 4.5:1.
 */

export const WCAG_AA_TEXT = 4.5;

function channel(hex: string, at: number): number {
  return parseInt(hex.slice(at, at + 2), 16) / 255;
}

function linearize(c: number): number {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance of a `#rrggbb` colour (throws on other shapes). */
export function relativeLuminance(hex: string): number {
  const h = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new Error(`relativeLuminance: expected #rrggbb, got ${hex}`);
  }
  return (
    0.2126 * linearize(channel(h, 0)) +
    0.7152 * linearize(channel(h, 2)) +
    0.0722 * linearize(channel(h, 4))
  );
}

/** WCAG contrast ratio between two `#rrggbb` colours (≥ 1). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export interface ContrastPair {
  label: string;
  fg: string;
  bg: string;
  /** Required minimum ratio (AA text = 4.5). */
  min: number;
}

const T = PORTAL_TOKENS;

/**
 * Every foreground/background pairing the shell renders body-size text in.
 * Add a row when a new token pair appears in layout.server.ts.
 */
export const PORTAL_CONTRAST_PAIRS: readonly ContrastPair[] = [
  { label: "muted text on card", fg: T.muted, bg: T.card, min: WCAG_AA_TEXT },
  { label: "muted text on page background", fg: T.muted, bg: T.bg, min: WCAG_AA_TEXT },
  { label: "muted text on grey chip", fg: T.muted, bg: T.chipGrey, min: WCAG_AA_TEXT },
  { label: "muted nav label on nav bar", fg: T.muted, bg: T.navBg, min: WCAG_AA_TEXT },
  { label: "ink on card", fg: T.ink, bg: T.card, min: WCAG_AA_TEXT },
  { label: "ink on page background", fg: T.ink, bg: T.bg, min: WCAG_AA_TEXT },
  { label: "amber notice text on amber-soft", fg: T.amber, bg: T.amberSoft, min: WCAG_AA_TEXT },
  { label: "amber chip text on card", fg: T.amber, bg: T.card, min: WCAG_AA_TEXT },
  { label: "danger text on danger-soft", fg: T.danger, bg: T.dangerSoft, min: WCAG_AA_TEXT },
  { label: "danger button text on card", fg: T.danger, bg: T.card, min: WCAG_AA_TEXT },
  { label: "accent text on accent-soft", fg: T.accent, bg: T.accentSoft, min: WCAG_AA_TEXT },
  { label: "accent (ghost button) on card", fg: T.accent, bg: T.card, min: WCAG_AA_TEXT },
  { label: "button label on accent", fg: T.accentInk, bg: T.accent, min: WCAG_AA_TEXT },
  ...T.rewardsGradient.map((stop) => ({
    label: `rewards muted text on gradient ${stop}`,
    fg: T.rewardsMuted,
    bg: stop,
    min: WCAG_AA_TEXT,
  })),
  ...T.rewardsGradient.map((stop) => ({
    label: `rewards text on gradient ${stop}`,
    fg: T.accentInk,
    bg: stop,
    min: WCAG_AA_TEXT,
  })),
  { label: "toast text on toast", fg: T.toastInk, bg: T.toastBg, min: WCAG_AA_TEXT },
  { label: "toast undo link on toast", fg: T.toastLink, bg: T.toastBg, min: WCAG_AA_TEXT },
];

export interface A11yFinding {
  check: string;
  ok: boolean;
  detail: string;
}

export interface PortalA11yAudit {
  ok: boolean;
  findings: A11yFinding[];
}

/** Contrast rows only (used by the audit and by tests). */
export function auditPortalContrast(): A11yFinding[] {
  return PORTAL_CONTRAST_PAIRS.map((pair) => {
    const ratio = contrastRatio(pair.fg, pair.bg);
    return {
      check: `contrast: ${pair.label}`,
      ok: ratio >= pair.min,
      detail: `${pair.fg} on ${pair.bg} = ${ratio.toFixed(2)}:1 (min ${pair.min}:1)`,
    };
  });
}

/**
 * Render the shell once (English, no session, no DB) and assert the static
 * accessibility contract: focus-visible outlines, reduced-motion block, skip
 * link + main landmark, polite status toast / assertive alert toast, no
 * window.confirm, ≥ 44px primary buttons.
 */
export function auditPortalShell(): PortalA11yAudit {
  const findings: A11yFinding[] = auditPortalContrast();
  const html = portalPage({
    locale: "en",
    title: "Accessibility audit",
    body: "<p>audit</p>",
    toast: { text: "ok", tone: "status" },
  });
  const alertHtml = portalPage({
    locale: "en",
    title: "Accessibility audit",
    body: "<p>audit</p>",
    toast: { text: "refused", tone: "alert" },
  });
  const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  const has = (check: string, ok: boolean, detail: string) =>
    findings.push({ check, ok, detail });

  has(
    "focus-visible outlines",
    /:focus-visible\{outline:2px solid/.test(style) &&
      /button:focus-visible/.test(style) &&
      /a:focus-visible/.test(style) &&
      /summary:focus-visible/.test(style) &&
      /input:focus-visible/.test(style),
    "buttons, links, inputs, selects, textareas and summaries carry a 2px focus-visible outline",
  );
  has(
    "reduced motion",
    /@media \(prefers-reduced-motion:reduce\)/.test(style) &&
      /transition:none !important;animation:none !important/.test(style),
    "prefers-reduced-motion disables transitions and animations",
  );
  has(
    "skip link + main landmark",
    /class="cxs-skip" href="#cxs-main"/.test(html) &&
      /<main id="cxs-main" tabindex="-1">/.test(html),
    "a skip-to-content link targets the focusable <main id=cxs-main>",
  );
  has(
    "single h1",
    (html.match(/<h1[\s>]/g) ?? []).length === 1,
    "the shell renders exactly one <h1> (the page title)",
  );
  has(
    "polite status toast",
    /class="cxs-toast" data-cellexia-toast role="status" aria-live="polite"/.test(html),
    "confirmation toasts are role=status / aria-live=polite",
  );
  has(
    "assertive alert toast",
    /class="cxs-toast" data-cellexia-toast role="alert"/.test(alertHtml),
    "refusal / error toasts are role=alert",
  );
  has(
    "no window.confirm",
    !/window\.confirm\(/.test(html) && /data-cellexia-confirm-panel/.test(html),
    "destructive removal confirms inline (Keep / Remove), never via window.confirm",
  );
  has(
    "primary buttons ≥ 44px",
    /\.cxs-btn\{[^}]*min-height:44px/.test(style) &&
      /\.cxs-btn--small\{[^}]*min-height:44px/.test(style) &&
      /\.cxs-nav a\{[^}]*min-height:56px/.test(style),
    "buttons and nav links reserve a ≥ 44px touch target",
  );
  has(
    "nav landmark labelled",
    /<nav class="cxs-nav" aria-label="/.test(html),
    "the bottom nav is a labelled <nav> landmark",
  );

  return { ok: findings.every((f) => f.ok), findings };
}
