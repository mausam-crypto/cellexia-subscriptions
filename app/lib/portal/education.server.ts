import { t } from "~/lib/i18n/i18n.server";
import { getSetting } from "~/lib/settings/settings.server";
import { escapeHtml } from "~/lib/portal/layout.server";

/**
 * Education hub (v1.28.0, P4.4).
 *
 * The three storefront URLs live in settings.portal (routineGuideUrl /
 * howToUseUrl / faqUrl); an empty string hides that link and the card
 * disappears when all three are empty. The cancel flow's EDUCATION save and
 * the saved page render the SAME resolved guide URL (`educationGuideUrl`), so
 * a merchant retargets one place and every surface follows — the old
 * hard-coded `/pages/routine-guide` i18n value is gone.
 *
 * Product metafields are NOT read: the app has no product-metafield reader
 * today (only shop metafields, for the launch status), so per-product how-to
 * links stay a settings-level URL — one page for the whole line-up.
 *
 * URLs are validated on the way out: only `https://…` or a store-relative
 * `/path` (never `//host`, never `javascript:`) survive; anything else is
 * treated as empty. Contained: a settings read failure yields no links.
 */
export interface EducationLinks {
  routineGuideUrl: string;
  howToUseUrl: string;
  faqUrl: string;
}

export const EMPTY_EDUCATION_LINKS: EducationLinks = {
  routineGuideUrl: "",
  howToUseUrl: "",
  faqUrl: "",
};

/**
 * `https://…` or a store-relative `/path`; everything else → "". Never
 * `//host` — and never `/\host` either: browsers normalise a backslash to a
 * slash for special schemes, so `/\evil.example/x` resolves off-store.
 */
export function sanitizeEducationUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const v = value.trim();
  if (!v || v.length > 500) return "";
  if (/^https:\/\/[^\s"'<>\\]+$/i.test(v)) return v;
  if (v.startsWith("/") && !v.startsWith("//") && !/[\s"'<>\\]/.test(v)) return v;
  return "";
}

/** Settings.portal.* URLs, sanitized. Never throws. */
export async function getEducationLinks(shopId: string): Promise<EducationLinks> {
  try {
    const portal = await getSetting(shopId, "portal");
    return {
      routineGuideUrl: sanitizeEducationUrl(portal.routineGuideUrl),
      howToUseUrl: sanitizeEducationUrl(portal.howToUseUrl),
      faqUrl: sanitizeEducationUrl(portal.faqUrl),
    };
  } catch (err) {
    console.error("[portal] education links unavailable", err);
    return { ...EMPTY_EDUCATION_LINKS };
  }
}

export function hasEducationLinks(links: EducationLinks): boolean {
  return !!(links.routineGuideUrl || links.howToUseUrl || links.faqUrl);
}

/**
 * The ONE guide URL the cancel flow's EDUCATION card and saved page link to:
 * the routine guide, else the how-to page, else the FAQ; null when nothing is
 * configured (the button is then not rendered — never a dead link).
 */
export function educationGuideUrl(links: EducationLinks): string | null {
  return links.routineGuideUrl || links.howToUseUrl || links.faqUrl || null;
}

export interface EducationCardInput {
  locale: string;
  links: EducationLinks;
  /**
   * Titles of the recurring products in the subscription: one → "How to use
   * {product}"; several → the generic plural; none → generic plural.
   */
  productTitles: string[];
  /**
   * In-page anchor of the Get-help card rendered further down the page
   * (the support agent's card, id="cxs-support"); null hides the entry.
   */
  helpHref: string | null;
}

/**
 * The "Get the most from your routine" card for the subscription detail
 * page (below the items card). Returns "" when no link is configured — the
 * Get-help entry alone does not justify a card, the support card is already
 * on the page.
 */
export function educationCardHtml(input: EducationCardInput): string {
  const { locale, links } = input;
  if (!hasEducationLinks(links)) return "";
  const distinct = [...new Set(input.productTitles.filter(Boolean))];
  const howToLabel =
    distinct.length === 1
      ? t(locale, "portal.education.how_to_use", { product: distinct[0] })
      : t(locale, "portal.education.how_to_use_plural");
  const link = (href: string, label: string, cls = "cxs-btn cxs-btn--ghost cxs-btn--small") =>
    `<a class="${cls}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  const rows: string[] = [];
  if (links.howToUseUrl) rows.push(link(links.howToUseUrl, howToLabel));
  if (links.routineGuideUrl) {
    rows.push(link(links.routineGuideUrl, t(locale, "portal.education.routine_guide")));
  }
  if (links.faqUrl) rows.push(link(links.faqUrl, t(locale, "portal.education.faq")));
  const help = input.helpHref
    ? `<p class="cxs-small cxs-education__help"><a href="${escapeHtml(input.helpHref)}">${escapeHtml(t(locale, "portal.education.get_help"))}</a></p>`
    : "";
  return `<section class="cxs-card cxs-education" aria-labelledby="cxs-education-title">
  <h2 id="cxs-education-title" style="font-size:18px;margin:0 0 6px">${escapeHtml(t(locale, "portal.education.title"))}</h2>
  <p class="cxs-muted cxs-small" style="margin:0">${escapeHtml(t(locale, "portal.education.intro"))}</p>
  <div class="cxs-education__links">${rows.join("")}</div>
  ${help}
</section>`;
}
