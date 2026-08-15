import { t } from "~/lib/i18n/i18n.server";
import { formatMoney } from "~/lib/money";
import {
  formatFrequency,
  frequencyToken,
  type Frequency,
} from "~/lib/frequency";
import { formatShopDate } from "~/lib/dates.server";
import { escapeHtml as esc, withLocale } from "~/lib/portal/layout.server";
import {
  PROXY_PUBLIC_BASE,
  REASONS,
  cancelPublicPath,
  portalPublicPath,
  type CancelReason,
} from "./config.server";
import type { SaveOffer } from "./engine.server";
import type { RetentionSummary } from "./summary.server";
import type { PageContent } from "./portal.server";

/**
 * Server-rendered HTML for every cancel-flow step, using the shared portal
 * layout classes (`.cxs-*`) plus a small scoped block (`.cxc-*`) for pieces
 * the layout doesn't have (loss list, radio cards). All copy goes through
 * t() with `cancel.*` keys so operators can tweak and A/B copy straight from
 * the locale catalogs. Mobile-first, no client JS beyond the layout's own.
 *
 * Compliance notes baked into the markup:
 * - "Continue to cancel" / "No thanks, cancel my subscription" controls are
 *   full-size buttons with the same dimensions and typography as the save
 *   CTAs (`.cxs-btn--ghost` vs solid differ only in fill) — equal visual
 *   weight, no dark patterns, decline is never a buried text link.
 * - Every mutating form carries the portal session's `_csrf` token.
 * - Forms POST to the store-domain proxy paths (`/apps/cellexia-subs/...`),
 *   preserving ?locale like every other portal page.
 */

const EXTRA_STYLE = `<style>
.cxc-list{margin:0 0 16px;padding:0;list-style:none}
.cxc-list li{padding:10px 14px;margin:0 0 8px;border-radius:10px;background:var(--cxs-accent-soft,#eef1ee);font-size:15px}
.cxc-radio{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border:1px solid var(--cxs-line,#ece7df);border-radius:10px;margin:0 0 8px;cursor:pointer;background:var(--cxs-card,#fff)}
.cxc-radio input{margin-top:4px}
.cxc-textarea{width:100%;min-height:72px;padding:10px 14px;border:1px solid var(--cxs-line,#ece7df);border-radius:8px;font:inherit;font-size:16px;margin:6px 0 14px}
.cxc-center{display:block;text-align:center;margin:10px 0 0;color:var(--cxs-muted,#8a837a);text-decoration:underline;font-size:14px;min-height:44px;line-height:44px}
.cxc-stack .cxs-btn{width:100%;margin:0 0 10px}
.cxc-hint{font-size:13px;color:var(--cxs-muted,#8a837a);text-align:center;margin:-4px 0 12px}
</style>`;

function postForm(
  action: string,
  hidden: Record<string, string>,
  buttonLabel: string,
  primary: boolean,
): string {
  const inputs = Object.entries(hidden)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`,
    )
    .join("");
  const cls = primary ? "cxs-btn cxs-btn--full" : "cxs-btn cxs-btn--ghost cxs-btn--full";
  return `<form method="post" action="${esc(action)}">${inputs}<button type="submit" class="${cls}">${esc(buttonLabel)}</button></form>`;
}

function stepAction(
  contractId: string,
  step: string | undefined,
  locale: string,
  preview?: string | null,
): string {
  return withLocale(cancelPublicPath(contractId, step), locale, preview);
}

// ── Step 1: before you go ────────────────────────────────────────────────────

export function pageIntro(args: {
  locale: string;
  csrf: string;
  contractId: string;
  firstName: string | null;
  summary: RetentionSummary;
  tz: string;
  copyVariant: "a" | "b";
  pauseMonths: number;
  showError: boolean;
  /** Preview session's raw cx_pp token — carried on every link/form URL. */
  previewToken?: string | null;
}): PageContent {
  const { locale, csrf, contractId, summary, tz, copyVariant } = args;
  const preview = args.previewToken ?? null;
  const name = args.firstName?.trim() || t(locale, "cancel.common.friend");

  const lossItems: string[] = [];
  if (summary.annualSavingsCents > 0) {
    lossItems.push(
      t(locale, "cancel.intro.savings_line", {
        annualSavings: formatMoney(summary.annualSavingsCents, summary.currencyCode, locale),
        perCycleSavings: formatMoney(summary.perCycleSavingsCents, summary.currencyCode, locale),
      }),
    );
  }
  if (summary.daysSubscribed > 0) {
    lossItems.push(t(locale, "cancel.intro.days_line", { days: summary.daysSubscribed }));
  }
  lossItems.push(
    summary.ordersToMilestone > 0
      ? t(locale, "cancel.intro.milestone_line", {
          ordersLeft: summary.ordersToMilestone,
          milestoneCycle: summary.milestoneCycle,
        })
      : t(locale, "cancel.intro.milestone_reached", {
          milestoneCycle: summary.milestoneCycle,
        }),
  );
  lossItems.push(
    summary.rewardsUnlocked
      ? t(locale, "cancel.intro.rewards_unlocked")
      : t(locale, "cancel.intro.rewards_countdown", { days: summary.daysToRewards }),
  );

  const nextDateLine = summary.nextBillingDate
    ? `<p class="cxs-muted cxs-small">${esc(
        t(locale, "cancel.intro.next_delivery", {
          date: formatShopDate(summary.nextBillingDate, tz, locale),
        }),
      )}</p>`
    : "";

  const body = `${EXTRA_STYLE}
${errorHtml(locale, args.showError)}
<p class="cxs-muted">${esc(t(locale, `cancel.intro.sub.${copyVariant}`))}</p>
<ul class="cxc-list">${lossItems.map((li) => `<li>${esc(li)}</li>`).join("")}</ul>
${nextDateLine}
<div class="cxc-stack">
${postForm(
  stepAction(contractId, undefined, locale, preview),
  { intent: "pause", months: String(args.pauseMonths), _csrf: csrf },
  t(locale, "cancel.intro.pause_cta", { months: args.pauseMonths }),
  true,
)}
<p class="cxc-hint">${esc(t(locale, "cancel.intro.pause_hint"))}</p>
${postForm(
  stepAction(contractId, undefined, locale, preview),
  { intent: "continue", _csrf: csrf },
  t(locale, "cancel.intro.continue_cta"),
  false,
)}
</div>
<a class="cxc-center" href="${esc(withLocale(portalPublicPath(), locale, preview))}">${esc(
    t(locale, "cancel.intro.keep_cta"),
  )}</a>`;

  return {
    title: t(locale, `cancel.intro.headline.${copyVariant}`, { firstName: name }),
    body,
  };
}

// ── Step 2: reason survey ────────────────────────────────────────────────────

export function pageReason(args: {
  locale: string;
  csrf: string;
  contractId: string;
  selectedReason: CancelReason | null;
  detail: string | null;
  showError: boolean;
  /** Preview session's raw cx_pp token — carried on every link/form URL. */
  previewToken?: string | null;
}): PageContent {
  const { locale, contractId } = args;
  const preview = args.previewToken ?? null;

  const radios = REASONS.map((r) => {
    const checked = args.selectedReason === r.key ? " checked" : "";
    return `<label class="cxc-radio"><input type="radio" name="reason" value="${esc(
      r.key,
    )}" required${checked}><span>${esc(t(locale, r.i18nKey))}</span></label>`;
  }).join("");

  const body = `${EXTRA_STYLE}
${errorHtml(locale, args.showError, "cancel.reason.required_error")}
<p class="cxs-muted">${esc(t(locale, "cancel.reason.sub"))}</p>
<form method="post" action="${esc(stepAction(contractId, "reason", locale, preview))}">
<input type="hidden" name="intent" value="reason_submit">
<input type="hidden" name="_csrf" value="${esc(args.csrf)}">
${radios}
<label class="cxs-label" for="cxc-detail">${esc(t(locale, "cancel.reason.detail_label"))}</label>
<textarea id="cxc-detail" class="cxc-textarea" name="detail" maxlength="1000">${esc(
    args.detail ?? "",
  )}</textarea>
<button type="submit" class="cxs-btn cxs-btn--full">${esc(
    t(locale, "cancel.reason.continue"),
  )}</button>
</form>
<a class="cxc-center" href="${esc(stepAction(contractId, "confirm", locale, preview))}">${esc(
    t(locale, "cancel.reason.skip"),
  )}</a>
<a class="cxc-center" href="${esc(withLocale(portalPublicPath(), locale, preview))}">${esc(
    t(locale, "cancel.intro.keep_cta"),
  )}</a>`;

  return { title: t(locale, "cancel.reason.title"), body };
}

// ── Step 3: reason-matched saves ─────────────────────────────────────────────

export function pageSaves(args: {
  locale: string;
  csrf: string;
  contractId: string;
  offers: SaveOffer[];
  tz: string;
  currencyCode: string;
  showError: boolean;
  /** Show the strictly opt-in "See my final offer" link (FTC: a save offer
   * beyond this page is only presented with the customer's affirmative
   * consent — the decline button below always completes immediately). */
  finalOfferEligible?: boolean;
  /** Preview session's raw cx_pp token — carried on every link/form URL. */
  previewToken?: string | null;
}): PageContent {
  const { locale, csrf, contractId, tz } = args;
  const preview = args.previewToken ?? null;
  const savesAction = stepAction(contractId, "saves", locale, preview);

  const cards = args.offers
    .map((offer) =>
      offerCard(offer, locale, csrf, savesAction, tz, args.currencyCode),
    )
    .join("");

  const finalOptIn = args.finalOfferEligible
    ? `<a class="cxs-btn cxs-btn--ghost cxs-btn--full" href="${esc(
        stepAction(contractId, "final", locale, preview),
      )}" style="margin-bottom:10px">${esc(t(locale, "cancel.final.see_offer"))}</a>`
    : "";

  const body = `${EXTRA_STYLE}
${errorHtml(locale, args.showError)}
<p class="cxs-muted">${esc(t(locale, "cancel.saves.sub"))}</p>
${cards}
<hr class="cxs-divider">
${finalOptIn}${postForm(
  stepAction(contractId, "confirm", locale, preview),
  { intent: "confirm_cancel", _csrf: csrf },
  t(locale, "cancel.saves.decline"),
  false,
)}
<a class="cxc-center" href="${esc(withLocale(portalPublicPath(), locale, preview))}">${esc(
    t(locale, "cancel.intro.keep_cta"),
  )}</a>`;

  return { title: t(locale, "cancel.saves.title"), body };
}

function offerCard(
  offer: SaveOffer,
  locale: string,
  csrf: string,
  savesAction: string,
  tz: string,
  currencyCode: string,
): string {
  const fmtDate = (iso: string | null): string =>
    iso
      ? formatShopDate(new Date(iso), tz, locale)
      : t(locale, "cancel.common.soon");

  switch (offer.kind) {
    case "SKIP":
      return card(
        t(locale, "cancel.saves.skip.title"),
        t(locale, "cancel.saves.skip.desc", { newDate: fmtDate(offer.newNextDate) }),
        postForm(
          savesAction,
          { intent: "accept_save", kind: "SKIP", _csrf: csrf },
          t(locale, "cancel.saves.skip.cta"),
          true,
        ),
      );
    case "FREQUENCY": {
      // Offers persisted before v1.8.0 carry only the week fields — they
      // were week cadences by construction, so WEEK is the exact fallback.
      const current: Frequency =
        offer.currentUnit != null && offer.currentCount != null
          ? { unit: offer.currentUnit, count: offer.currentCount }
          : { unit: "WEEK", count: offer.currentWeeks };
      const suggested: Frequency =
        offer.suggestedUnit != null && offer.suggestedCount != null
          ? { unit: offer.suggestedUnit, count: offer.suggestedCount }
          : { unit: "WEEK", count: offer.suggestedWeeks };
      const tt = (key: string, vars?: Record<string, string | number>) =>
        t(locale, key, vars);
      const frequency = formatFrequency(tt, "every", suggested);
      return card(
        t(locale, "cancel.saves.frequency.title"),
        t(locale, "cancel.saves.frequency.desc", {
          frequency,
          currentFrequency: formatFrequency(tt, "every", current),
          date: fmtDate(offer.estNextDate),
        }),
        postForm(
          savesAction,
          {
            intent: "accept_save",
            kind: "FREQUENCY",
            frequency: frequencyToken(suggested),
            // Legacy field — kept through the transition window so a page
            // rendered by the previous build still accepts cleanly.
            weeks: String(offer.suggestedWeeks),
            _csrf: csrf,
          },
          t(locale, "cancel.saves.frequency.cta", { frequency }),
          true,
        ),
      );
    }
    case "PAUSE":
      return card(
        t(locale, "cancel.saves.pause.title", { months: offer.months }),
        t(locale, "cancel.saves.pause.desc", { resumeDate: fmtDate(offer.resumeDate) }),
        postForm(
          savesAction,
          {
            intent: "accept_save",
            kind: "PAUSE",
            months: String(offer.months),
            _csrf: csrf,
          },
          t(locale, "cancel.saves.pause.cta", { months: offer.months }),
          true,
        ),
      );
    case "DISCOUNT":
      return card(
        t(locale, "cancel.saves.discount.title", {
          percent: offer.percent,
          cycles: offer.cycles,
        }),
        t(locale, "cancel.saves.discount.desc", {
          savings: formatMoney(offer.estSavingsCentsPerCycle, offer.currencyCode, locale),
        }),
        postForm(
          savesAction,
          { intent: "accept_save", kind: "DISCOUNT", _csrf: csrf },
          t(locale, "cancel.saves.discount.cta", { percent: offer.percent }),
          true,
        ),
      );
    case "SWAP": {
      const options = offer.options
        .map(
          (o) => `<p>${esc(o.title)} — <span class="cxs-price">${esc(
            t(locale, "cancel.saves.swap.price_line", {
              price: formatMoney(o.displayPriceCents, currencyCode, locale),
            }),
          )}</span></p>
${postForm(
  savesAction,
  {
    intent: "accept_save",
    kind: "SWAP",
    lineId: offer.lineId,
    variantId: o.variantId,
    _csrf: csrf,
  },
  t(locale, "cancel.saves.swap.option_cta", { variantTitle: o.title }),
  true,
)}`,
        )
        .join("");
      return card(
        t(locale, "cancel.saves.swap.title"),
        t(locale, "cancel.saves.swap.desc", { lineTitle: offer.lineTitle }),
        options,
      );
    }
    case "GIFT":
      return card(
        t(locale, "cancel.saves.gift.title"),
        t(locale, "cancel.saves.gift.desc", {
          giftTitle: offer.title,
          retailPrice: formatMoney(offer.retailCents, offer.currencyCode, locale),
        }),
        `${
          offer.imageUrl
            ? `<img src="${esc(offer.imageUrl)}" alt="${esc(offer.title)}" style="display:block;max-width:160px;max-height:160px;border-radius:8px;margin:0 auto 12px" />`
            : ""
        }${postForm(
          savesAction,
          { intent: "accept_save", kind: "GIFT", _csrf: csrf },
          t(locale, "cancel.saves.gift.cta"),
          true,
        )}`,
      );
    case "EDUCATION":
      return card(
        t(locale, "cancel.saves.education.title"),
        t(locale, "cancel.saves.education.desc"),
        `<a class="cxs-btn cxs-btn--ghost cxs-btn--full" href="${esc(
          t(locale, "cancel.saves.education.guide_url"),
        )}" style="margin-bottom:10px">${esc(t(locale, "cancel.saves.education.guide_cta"))}</a>
<a class="cxs-btn cxs-btn--ghost cxs-btn--full" href="${esc(
          t(locale, "cancel.saves.education.consult_url"),
        )}" style="margin-bottom:10px">${esc(t(locale, "cancel.saves.education.consult_cta"))}</a>
${postForm(
  savesAction,
  { intent: "accept_save", kind: "EDUCATION", _csrf: csrf },
  t(locale, "cancel.saves.education.stay_cta"),
  true,
)}`,
      );
    case "SUPPORT":
      return card(
        t(locale, "cancel.saves.support.title"),
        t(locale, "cancel.saves.support.desc"),
        `<a class="cxs-btn cxs-btn--ghost cxs-btn--full" href="${esc(
          t(locale, "cancel.saves.support.contact_url"),
        )}" style="margin-bottom:10px">${esc(t(locale, "cancel.saves.support.contact_cta"))}</a>
${postForm(
  savesAction,
  { intent: "accept_save", kind: "SUPPORT", _csrf: csrf },
  t(locale, "cancel.saves.support.stay_cta"),
  true,
)}`,
      );
    case "FINAL_DISCOUNT":
      // Never rendered as a step-3 card; the final offer has its own page.
      return "";
  }
}

function card(title: string, desc: string, bodyHtml: string): string {
  return `<div class="cxs-card"><h2 style="font-size:17px;margin:0 0 6px">${esc(
    title,
  )}</h2><p style="margin:0 0 12px">${esc(desc)}</p>${bodyHtml}</div>`;
}

function errorHtml(locale: string, show: boolean, key = "cancel.error.generic"): string {
  return show ? `<p class="cxs-error">${esc(t(locale, key))}</p>` : "";
}

// ── Step 4: final chance ─────────────────────────────────────────────────────

export function pageFinal(args: {
  locale: string;
  csrf: string;
  contractId: string;
  percent: number;
  cycles: number;
  copyVariant: "a" | "b";
  showError: boolean;
  /** Preview session's raw cx_pp token — carried on every link/form URL. */
  previewToken?: string | null;
}): PageContent {
  const { locale, csrf, contractId, percent, cycles } = args;
  const preview = args.previewToken ?? null;

  const body = `${EXTRA_STYLE}
${errorHtml(locale, args.showError)}
<p class="cxs-muted">${esc(t(locale, "cancel.final.sub", { percent, cycles }))}</p>
${card(
  t(locale, "cancel.final.card_title", { percent, cycles }),
  t(locale, "cancel.final.card_desc"),
  postForm(
    stepAction(contractId, "final", locale, preview),
    { intent: "accept_final", _csrf: csrf },
    t(locale, "cancel.final.accept", { percent }),
    true,
  ),
)}
${postForm(
  stepAction(contractId, "confirm", locale, preview),
  { intent: "confirm_cancel", _csrf: csrf },
  t(locale, "cancel.final.decline"),
  false,
)}`;

  return { title: t(locale, `cancel.final.title.${args.copyVariant}`), body };
}

// ── Step 5: confirm ──────────────────────────────────────────────────────────

export function pageConfirm(args: {
  locale: string;
  csrf: string;
  contractId: string;
  showError: boolean;
  /** Opt-in link to the final offer — never auto-interjected (FTC). */
  finalOfferEligible?: boolean;
  /** Preview session's raw cx_pp token — carried on every link/form URL. */
  previewToken?: string | null;
}): PageContent {
  const { locale, csrf, contractId } = args;
  const preview = args.previewToken ?? null;
  const points = [
    "cancel.confirm.point_no_charges",
    "cancel.confirm.point_no_shipments",
    "cancel.confirm.point_lose",
    "cancel.confirm.point_resume",
  ]
    .map((key) => `<li>${esc(t(locale, key))}</li>`)
    .join("");

  const finalOptIn = args.finalOfferEligible
    ? `<a class="cxc-center" href="${esc(
        stepAction(contractId, "final", locale, preview),
      )}">${esc(t(locale, "cancel.final.see_offer"))}</a>`
    : "";

  const body = `${EXTRA_STYLE}
${errorHtml(locale, args.showError)}
<p class="cxs-muted">${esc(t(locale, "cancel.confirm.what_happens"))}</p>
<ul class="cxc-list">${points}</ul>
${postForm(
  stepAction(contractId, "confirm", locale, preview),
  { intent: "confirm_cancel", _csrf: csrf },
  t(locale, "cancel.confirm.cta"),
  true,
)}
<a class="cxs-btn cxs-btn--ghost cxs-btn--full" href="${esc(
    withLocale(portalPublicPath(), locale, preview),
  )}">${esc(t(locale, "cancel.confirm.keep"))}</a>
${finalOptIn}`;

  return { title: t(locale, "cancel.confirm.title"), body };
}

// ── Done ─────────────────────────────────────────────────────────────────────

export function pageDone(args: {
  locale: string;
  /** When present, render the one-tap restart CTA (LTGP: a cancelled
   * customer who changes their mind must never hit a dead-end). */
  contractId?: string;
  csrf?: string;
  /** Preview session's raw cx_pp token — carried on every link/form URL. */
  previewToken?: string | null;
}): PageContent {
  const { locale } = args;
  const preview = args.previewToken ?? null;

  // One-tap reactivation straight from the goodbye page — posts to the portal
  // reactivate action (winback engine's reactivateFromWinback under the hood,
  // no discount attached).
  const restart =
    args.contractId && args.csrf
      ? `<form method="post" action="${esc(
          withLocale(`${PROXY_PUBLIC_BASE}/api/reactivate`, locale, preview),
        )}"><input type="hidden" name="contractId" value="${esc(args.contractId)}"><input type="hidden" name="_csrf" value="${esc(args.csrf)}"><input type="hidden" name="return_to" value="/"><button type="submit" class="cxs-btn cxs-btn--ghost cxs-btn--full" style="margin-top:10px">${esc(
          t(locale, "cancel.done.restart_cta"),
        )}</button></form>`
      : "";

  const body = `${EXTRA_STYLE}
<p>${esc(t(locale, "cancel.done.no_charges"))}</p>
<p>${esc(t(locale, "cancel.done.resume"))}</p>
<p class="cxs-muted cxs-small">${esc(t(locale, "cancel.done.winback_seed"))}</p>
<a class="cxs-btn cxs-btn--full" href="${esc(withLocale(portalPublicPath(), locale, preview))}">${esc(
    t(locale, "cancel.done.portal_cta"),
  )}</a>
${restart}`;
  return { title: t(locale, "cancel.done.title"), body };
}

// ── Saved confirmation ───────────────────────────────────────────────────────

export function pageSaved(args: {
  locale: string;
  contractId: string;
  messageKey: string;
  messageVars: Record<string, string | number>;
  showEducationLinks: boolean;
  showSupportLink: boolean;
  /** Preview session's raw cx_pp token — carried on every link/form URL. */
  previewToken?: string | null;
}): PageContent {
  const { locale, contractId } = args;
  const preview = args.previewToken ?? null;

  let extras = "";
  if (args.showEducationLinks) {
    extras = `<a class="cxs-btn cxs-btn--ghost cxs-btn--full" href="${esc(
      t(locale, "cancel.saves.education.guide_url"),
    )}" style="margin-bottom:10px">${esc(t(locale, "cancel.saves.education.guide_cta"))}</a>
<a class="cxs-btn cxs-btn--ghost cxs-btn--full" href="${esc(
      t(locale, "cancel.saves.education.consult_url"),
    )}" style="margin-bottom:10px">${esc(t(locale, "cancel.saves.education.consult_cta"))}</a>`;
  } else if (args.showSupportLink) {
    extras = `<a class="cxs-btn cxs-btn--ghost cxs-btn--full" href="${esc(
      t(locale, "cancel.saves.support.contact_url"),
    )}" style="margin-bottom:10px">${esc(t(locale, "cancel.saves.support.contact_cta"))}</a>`;
  }

  const body = `${EXTRA_STYLE}
<p>${esc(t(locale, args.messageKey, args.messageVars))}</p>
${extras}
<a class="cxs-btn cxs-btn--full" href="${esc(withLocale(portalPublicPath(), locale, preview))}">${esc(
    t(locale, "cancel.saved.portal_cta"),
  )}</a>
<a class="cxc-center" href="${esc(withLocale(cancelPublicPath(contractId), locale, preview))}">${esc(
    t(locale, "cancel.saved.cancel_link"),
  )}</a>`;

  return { title: t(locale, "cancel.saved.title"), body };
}
