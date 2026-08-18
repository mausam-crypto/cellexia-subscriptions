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
import { retentionLossLines, type RetentionSummary } from "./summary.server";
import type { PageContent } from "./portal.server";
import {
  EMPTY_SUPPORT_CHANNELS,
  type ReplyPromise,
  type SupportChannels,
} from "~/lib/support/channels.server";
import { supportChannelsHtml } from "~/lib/support/portal-card.server";
import { supportReplyPromise } from "~/lib/support/reply-promise.server";
import {
  EMPTY_EDUCATION_LINKS,
  educationGuideUrl,
  type EducationLinks,
} from "~/lib/portal/education.server";
import { SUPPORT_MESSAGE_MAX } from "~/lib/support/request.server";

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
.cxc-center{display:block;text-align:center;margin:10px 0 0;color:var(--cxs-muted,#6f6a62);text-decoration:underline;font-size:14px;min-height:44px;line-height:44px}
.cxc-stack .cxs-btn{width:100%;margin:0 0 10px}
.cxc-hint{font-size:13px;color:var(--cxs-muted,#6f6a62);text-align:center;margin:-4px 0 12px}
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

/**
 * "Read the routine guide" button (EDUCATION card + saved page). The href is
 * settings-resolved (portal.routineGuideUrl → howToUseUrl → faqUrl); with no
 * URL configured the button is simply absent — never a link to nowhere.
 */
function educationGuideLinkHtml(locale: string, education: EducationLinks): string {
  const href = educationGuideUrl(education);
  if (!href) return "";
  return `<a class="cxs-btn cxs-btn--ghost cxs-btn--full" href="${esc(href)}" style="margin-bottom:10px">${esc(
    t(locale, "cancel.saves.education.guide_cta"),
  )}</a>`;
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
  /**
   * Already-PAUSED contract (v1.28.0 review fix): the one-tap "pause for N
   * months" is replaced by the exit ramp — "extend my break until {date}"
   * per offered choice (empty choices ⇒ just the note; never a no-op CTA).
   */
  paused?: {
    /** null ⇒ a hold without a resume day (admin/external pause): note only. */
    resumeAt: Date | null;
    choices: ReadonlyArray<{ weeks: number; resumeAt: Date }>;
  } | null;
  /**
   * Plan lock window (v1.28.0, P3.8): the contract is inside its commitment
   * period — the one-tap pause (a schedule reduction) is not offered; a
   * factual line states the period ends on {until} and that the flow can
   * schedule the cancellation for that day. Cancel stays reachable.
   */
  locked?: { until: Date } | null;
}): PageContent {
  const { locale, csrf, contractId, summary, tz, copyVariant } = args;
  const preview = args.previewToken ?? null;
  const name = args.firstName?.trim() || t(locale, "cancel.common.friend");
  const locked = args.locked ?? null;

  // Money-true, ladder-aware ledger (v1.28.0): every line is proven by the
  // summary's data; zero/unknown values render nothing.
  const lossItems = lossLines(summary, locale);

  const nextDateLine = summary.nextBillingDate
    ? `<p class="cxs-muted cxs-small">${esc(
        t(locale, "cancel.intro.next_delivery", {
          date: formatShopDate(summary.nextBillingDate, tz, locale),
        }),
      )}</p>`
    : "";
  // Rewards roadmap seam (v1.28.0, P4.3): the projected date of the next
  // milestone rung, right under the ledger — same schedule math as the
  // portal roadmap, shown only when a rung is ahead and the date is knowable.
  const milestoneAroundLine =
    summary.nextMilestoneCycle != null &&
    summary.ordersToMilestone > 0 &&
    summary.nextMilestoneAt
      ? `<p class="cxs-muted cxs-small cxc-milestone-around">${esc(
          t(locale, "cancel.intro.milestone_around", {
            milestoneCycle: summary.nextMilestoneCycle,
            date: formatShopDate(summary.nextMilestoneAt, tz, locale),
          }),
        )}</p>`
      : "";

  const body = `${EXTRA_STYLE}
${errorHtml(locale, args.showError)}
<p class="cxs-muted">${esc(t(locale, `cancel.intro.sub.${copyVariant}`))}</p>
<ul class="cxc-list">${lossItems.map((li) => `<li>${esc(li)}</li>`).join("")}</ul>
${nextDateLine}${milestoneAroundLine}
<div class="cxc-stack">
${
  locked
    ? `<p class="cxs-muted cxs-small cxc-locked-note">${esc(
        t(locale, "cancel.intro.locked_note", {
          date: formatShopDate(locked.until, tz, locale),
        }),
      )}</p>`
    : args.paused
    ? `<p class="cxs-muted cxs-small">${esc(
        args.paused.resumeAt
          ? t(locale, "cancel.intro.paused_note", {
              date: formatShopDate(args.paused.resumeAt, tz, locale),
            })
          : t(locale, "cancel.intro.paused_note_nodate"),
      )}</p>${args.paused.choices
        .map((c, i) =>
          postForm(
            stepAction(contractId, undefined, locale, preview),
            { intent: "extend_pause", weeks: String(c.weeks), _csrf: csrf },
            t(locale, "cancel.intro.extend_pause_cta", {
              date: formatShopDate(c.resumeAt, tz, locale),
            }),
            i === 0,
          ),
        )
        .join("")}`
    : `${postForm(
        stepAction(contractId, undefined, locale, preview),
        { intent: "pause", months: String(args.pauseMonths), _csrf: csrf },
        t(locale, "cancel.intro.pause_cta", { months: args.pauseMonths }),
        true,
      )}
<p class="cxc-hint">${esc(t(locale, "cancel.intro.pause_hint"))}</p>`
}
${postForm(
  stepAction(contractId, undefined, locale, preview),
  { intent: "continue", _csrf: csrf },
  t(locale, locked ? "cancel.intro.continue_cta_locked" : "cancel.intro.continue_cta"),
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
  /**
   * Specific refusal copy for the error banner (v1.28.0 review fix): the
   * `cycle_edits` kind — Shopify refused the contract-level save while
   * one-off changes are staged on the next order — reads the portal's own
   * honest toast copy; anything else keeps the generic line.
   */
  errorKind?: string | null;
  /** Show the strictly opt-in "See my final offer" link (FTC: a save offer
   * beyond this page is only presented with the customer's affirmative
   * consent — the decline button below always completes immediately). */
  finalOfferEligible?: boolean;
  /** Preview session's raw cx_pp token — carried on every link/form URL. */
  previewToken?: string | null;
  /**
   * Resolved support channels (v1.28.0, P5.1) — the SUPPORT / EDUCATION
   * cards render the merchant's real contact buttons and an inline Get-help
   * form instead of a hard-coded mailto:. Omitted ⇒ form only.
   */
  support?: SupportChannels;
  /**
   * Education hub links (v1.28.0, P4.4 — settings.portal.routineGuideUrl /
   * howToUseUrl / faqUrl): the EDUCATION card's guide button points at the
   * same URL the portal's routine card does; no link ⇒ no button.
   */
  education?: EducationLinks;
  /**
   * Whether the pause-ending reminder will actually be sent
   * (resumeReminderPromised — channel + template switches): only then may
   * the PAUSE card promise "we'll remind you". Omitted ⇒ no promise.
   */
  resumeReminder?: boolean;
  /**
   * Results-timeline phase copy for the customer's routine week (v1.28.0,
   * P4.1 — educationTimelineText): replaces the EDUCATION card's static
   * "8–12 weeks" sentence when set. Null/omitted = the static copy (timeline
   * disabled, or the customer is in the results_timeline holdout arm).
   */
  educationTimelineText?: string | null;
  /**
   * Concierge save (v1.28.0, P3.7): what the SUPPORT card promises and
   * prefills — the Get-help topic matched to the cancel reason, the survey
   * free text as the message draft, the reply promise (support.replyWithin*)
   * and, when the hold WOULD apply right now (conciergeHoldPlan), the day the
   * next order moves to. Omitted ⇒ Stage C's plain form.
   */
  concierge?: ConciergeCardInfo | null;
}): PageContent {
  const { locale, csrf, contractId, tz } = args;
  const preview = args.previewToken ?? null;
  const savesAction = stepAction(contractId, "saves", locale, preview);
  const support = args.support ?? EMPTY_SUPPORT_CHANNELS;
  const education = args.education ?? EMPTY_EDUCATION_LINKS;
  const resumeReminder = args.resumeReminder === true;
  const educationTimelineText = args.educationTimelineText ?? null;
  const concierge = args.concierge ?? null;

  const cards = args.offers
    .map((offer) =>
      offerCard(
        offer,
        locale,
        csrf,
        savesAction,
        tz,
        args.currencyCode,
        support,
        education,
        resumeReminder,
        educationTimelineText,
        concierge,
      ),
    )
    .join("");

  const finalOptIn = args.finalOfferEligible
    ? `<a class="cxs-btn cxs-btn--ghost cxs-btn--full" href="${esc(
        stepAction(contractId, "final", locale, preview),
      )}" style="margin-bottom:10px">${esc(t(locale, "cancel.final.see_offer"))}</a>`
    : "";

  const body = `${EXTRA_STYLE}
${errorHtml(
  locale,
  args.showError,
  args.errorKind === "cycle_edits" ? "portal.toast.cycle_edits_pending" : "cancel.error.generic",
)}
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

/** Concierge (SUPPORT) card inputs — see pageSaves.concierge. */
export interface ConciergeCardInfo {
  topic: "DELIVERY" | "PAYMENT" | "PLAN" | "OTHER";
  /** Message draft (the survey's free text), "" when none. */
  prefill: string;
  replyWithin: ReplyPromise;
  /** The day the next order moves to when the hold applies; null = no hold. */
  holdUntil: Date | null;
  holdDays: number;
}

function offerCard(
  offer: SaveOffer,
  locale: string,
  csrf: string,
  savesAction: string,
  tz: string,
  currencyCode: string,
  support: SupportChannels = EMPTY_SUPPORT_CHANNELS,
  education: EducationLinks = EMPTY_EDUCATION_LINKS,
  resumeReminder = false,
  educationTimelineText: string | null = null,
  concierge: ConciergeCardInfo | null = null,
): string {
  const fmtDate = (iso: string | null): string =>
    iso
      ? formatShopDate(new Date(iso), tz, locale)
      : t(locale, "cancel.common.soon");

  switch (offer.kind) {
    case "DELAY": {
      // "Push my next order to {predicted empty date}" (v1.28.0, P3.3): the
      // date is the exact day the delay sets; the mode line tells the truth
      // about what follows (whole schedule moves vs this order only).
      return card(
        t(locale, "cancel.saves.delay.title"),
        t(
          locale,
          offer.mode === "reanchor"
            ? "cancel.saves.delay.desc_reanchor"
            : "cancel.saves.delay.desc_once",
          { newDate: fmtDate(offer.newNextDate), days: offer.days },
        ),
        postForm(
          savesAction,
          { intent: "accept_save", kind: "DELAY", _csrf: csrf },
          t(locale, "cancel.saves.delay.cta", { newDate: fmtDate(offer.newNextDate) }),
          true,
        ),
      );
    }
    case "SKIP": {
      // Per-line "Skip just {product}" (v1.28.0, P2.5): secondary buttons
      // under the whole-order skip when the offer carries lines
      // (TOO_MUCH_PRODUCT on a multi-product subscription). Same action,
      // same kind, plus lineId — the engine checks it against the offer.
      const perLine =
        offer.lines && offer.lines.length >= 2
          ? `<p class="cxc-hint" style="text-align:left;margin:8px 0 8px">${esc(t(locale, "cancel.saves.skip.line_hint"))}</p>${offer.lines
              .map((l) =>
                postForm(
                  savesAction,
                  { intent: "accept_save", kind: "SKIP", lineId: l.lineId, _csrf: csrf },
                  t(locale, "cancel.saves.skip.line_cta", { title: l.title }),
                  false,
                ),
              )
              .join("")}`
          : "";
      return card(
        t(locale, "cancel.saves.skip.title"),
        t(locale, "cancel.saves.skip.desc", { newDate: fmtDate(offer.newNextDate) }),
        `${postForm(
          savesAction,
          { intent: "accept_save", kind: "SKIP", _csrf: csrf },
          t(locale, "cancel.saves.skip.cta"),
          true,
        )}${perLine}`,
      );
    }
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
      // PAUSED canceller (v1.28.0): "resume later, at a slower cadence" —
      // the hold stands (nothing charged before the resume day), the slower
      // cadence applies from the first order after it. Same accept form.
      const paused = offer.pausedResumeAt != null;
      return card(
        t(locale, paused ? "cancel.saves.frequency_paused.title" : "cancel.saves.frequency.title"),
        paused
          ? t(locale, "cancel.saves.frequency_paused.desc", {
              frequency,
              currentFrequency: formatFrequency(tt, "every", current),
              resumeDate: fmtDate(offer.pausedResumeAt ?? offer.estNextDate),
            })
          : t(locale, "cancel.saves.frequency.desc", {
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
          t(
            locale,
            paused ? "cancel.saves.frequency_paused.cta" : "cancel.saves.frequency.cta",
            { frequency },
          ),
          true,
        ),
      );
    }
    case "PAUSE":
      return card(
        t(locale, "cancel.saves.pause.title", { months: offer.months }),
        t(
          locale,
          resumeReminder ? "cancel.saves.pause.desc" : "cancel.saves.pause.desc_noremind",
          { resumeDate: fmtDate(offer.resumeDate) },
        ),
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
    case "EXTEND_PAUSE": {
      // Pause exit ramp (v1.28.0): the contract is already on hold — offer
      // to push the resume day back, one full-size button per choice (the
      // first is primary). Every date on the card is the exact day
      // extendPause will set.
      const buttons = offer.choices
        .map((c, i) =>
          postForm(
            savesAction,
            {
              intent: "accept_save",
              kind: "EXTEND_PAUSE",
              weeks: String(c.weeks),
              _csrf: csrf,
            },
            t(locale, "cancel.saves.extend_pause.cta", { resumeDate: fmtDate(c.resumeAt) }),
            i === 0,
          ),
        )
        .join("");
      return card(
        t(locale, "cancel.saves.extend_pause.title"),
        t(locale, "cancel.saves.extend_pause.desc", {
          resumeDate: fmtDate(offer.currentResumeAt),
        }),
        buttons,
      );
    }
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
    case "DOWNSIZE": {
      const cur = formatMoney(offer.currentTotalCents, offer.currencyCode, locale);
      const options = offer.options
        .map((o) => {
          const total = formatMoney(o.newTotalCents, offer.currencyCode, locale);
          const label =
            o.mode === "QUANTITY"
              ? t(locale, "cancel.saves.downsize.option_quantity", {
                  quantity: o.quantity ?? 1,
                  title: o.title,
                })
              : o.mode === "VARIANT"
                ? t(locale, "cancel.saves.downsize.option_variant", {
                    variantTitle: o.title,
                  })
                : t(locale, "cancel.saves.downsize.option_product", {
                    productTitle: o.title,
                  });
          const hidden: Record<string, string> = {
            intent: "accept_save",
            kind: "DOWNSIZE",
            lineId: offer.lineId,
            _csrf: csrf,
          };
          if (o.mode === "QUANTITY") hidden.quantity = String(o.quantity ?? 1);
          else if (o.variantId) hidden.variantId = o.variantId;
          return `<p>${esc(label)} — <span class="cxs-price">${esc(
            t(locale, "cancel.saves.downsize.total_line", { total, current: cur }),
          )}</span></p>
${postForm(
  savesAction,
  hidden,
  t(locale, "cancel.saves.downsize.option_cta", { total }),
  true,
)}`;
        })
        .join("");
      // A live discount is not folded into the plan-price figures (it is
      // temporary); say so next to them so the card never seems to
      // contradict the discounted hero total the customer just read.
      const discountNote =
        offer.discountPercent != null &&
        offer.discountPercent > 0 &&
        offer.discountCyclesRemaining != null &&
        offer.discountCyclesRemaining > 0
          ? `<p class="cxc-hint">${esc(
              t(
                locale,
                offer.discountCyclesRemaining === 1
                  ? "cancel.saves.downsize.discount_note_one"
                  : "cancel.saves.downsize.discount_note",
                {
                  percent: offer.discountPercent,
                  count: offer.discountCyclesRemaining,
                },
              ),
            )}</p>`
          : "";
      return card(
        t(locale, "cancel.saves.downsize.title"),
        t(locale, "cancel.saves.downsize.desc", { lineTitle: offer.lineTitle }),
        discountNote + options,
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
      // Guide link stays a plain link (reading is not a save). The
      // consultation is the inline Get-help form: submitting it IS the save
      // (acceptSave refuses a bare accept — analytics truth, v1.28.0).
      // Phase-aware copy (P4.1): the results-timeline sentence for the
      // customer's own week when the caller resolved one; the static
      // sentence otherwise (timeline off / holdout arm).
      return card(
        t(locale, "cancel.saves.education.title"),
        educationTimelineText || t(locale, "cancel.saves.education.desc"),
        `${educationGuideLinkHtml(locale, education)}
${supportChannelsHtml(locale, support, t(locale, "cancel.saves.education.consult_subject"))}
${supportSaveForm(savesAction, csrf, locale, "EDUCATION")}`,
      );
    case "SUPPORT": {
      // Concierge save (v1.28.0, P3.7): the in-flow request form — topic
      // prefilled from the cancel reason, the survey free text as the draft,
      // the reply promise, and the next-order hold ONLY when it will apply
      // (conciergeHoldPlan decided; the accept path applies the same rule).
      const promise = concierge
        ? `<p class="cxs-muted cxs-small cxc-concierge-promise" style="margin:0 0 6px">${esc(
            supportReplyPromise(locale, concierge),
          )}${
            concierge.holdUntil
              ? ` ${esc(
                  t(locale, "cancel.saves.support.hold_line", {
                    date: formatShopDate(concierge.holdUntil, tz, locale),
                  }),
                )}`
              : ""
          }</p>`
        : "";
      return card(
        t(locale, "cancel.saves.support.title"),
        t(locale, "cancel.saves.support.desc"),
        `${supportChannelsHtml(locale, support, t(locale, "cancel.saves.support.contact_subject"))}
${promise}${supportSaveForm(savesAction, csrf, locale, "SUPPORT", concierge)}`,
      );
    }
    case "FINAL_DISCOUNT":
      // Never rendered as a step-3 card; the final offer has its own page.
      return "";
  }
}

/** Localized loss ledger shared by the intro list and the confirm page. */
function lossLines(
  summary: RetentionSummary,
  locale: string,
  mode: "intro" | "confirm" = "intro",
): string[] {
  return retentionLossLines(
    summary,
    (cents) => formatMoney(cents, summary.currencyCode, locale),
    mode,
  ).map((line) => t(locale, line.key, line.vars));
}

/**
 * The inline Get-help form of the SUPPORT / EDUCATION save cards (v1.28.0):
 * posts `intent=accept_save&kind=…` plus the request (topic fixed by the
 * card — DELIVERY for SUPPORT, OTHER for the consultation — and a required
 * message). Same fields the portal form sends, same server path
 * (submitSupportRequest), one honesty rule: no message, no save.
 */
function supportSaveForm(
  savesAction: string,
  csrf: string,
  locale: string,
  kind: "EDUCATION" | "SUPPORT",
  concierge: ConciergeCardInfo | null = null,
): string {
  // Concierge (P3.7): topic follows the cancel reason (delivery / plan /
  // other) and the survey's free text is the draft — the customer already
  // told us what is wrong; they should not have to type it twice.
  const topic =
    kind === "SUPPORT" ? (concierge?.topic ?? "DELIVERY") : "OTHER";
  const prefill = kind === "SUPPORT" ? (concierge?.prefill ?? "") : "";
  const introKey =
    kind === "SUPPORT" ? "cancel.saves.support.form_intro" : "cancel.saves.education.form_intro";
  const ctaKey =
    kind === "SUPPORT" ? "cancel.saves.support.form_cta" : "cancel.saves.education.form_cta";
  const id = `cxc-support-${kind.toLowerCase()}`;
  return `<form method="post" action="${esc(savesAction)}" class="cxc-support">
<input type="hidden" name="intent" value="accept_save"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="hidden" name="support_topic" value="${topic}">
<p class="cxs-muted cxs-small" style="margin:10px 0 6px">${esc(t(locale, introKey))}</p>
<label class="cxs-label" for="${id}">${esc(t(locale, "portal.support.message_label"))}</label>
<textarea class="cxc-textarea" name="support_message" id="${id}" maxlength="${SUPPORT_MESSAGE_MAX}" required placeholder="${esc(t(locale, "portal.support.message_placeholder"))}">${esc(prefill)}</textarea>
<button type="submit" class="cxs-btn cxs-btn--full">${esc(t(locale, ctaKey))}</button>
<p class="cxc-hint" style="margin-top:8px">${esc(t(locale, "portal.support.privacy"))}</p>
</form>`;
}

function card(title: string, desc: string, bodyHtml: string): string {
  return `<div class="cxs-card"><h2 style="font-size:17px;margin:0 0 6px">${esc(
    title,
  )}</h2><p style="margin:0 0 12px">${esc(desc)}</p>${bodyHtml}</div>`;
}

function errorHtml(locale: string, show: boolean, key = "cancel.error.generic"): string {
  return show ? `<p class="cxs-error" role="alert">${esc(t(locale, key))}</p>` : "";
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
  /** Money-true retention summary (v1.28.0): renders the CONCRETE losses
   * (locked price, member savings, discount cycles left, next milestone,
   * gifts, rewards) between the generic points; omitted → generic only. */
  summary?: RetentionSummary | null;
  /** Preview session's raw cx_pp token — carried on every link/form URL. */
  previewToken?: string | null;
  /**
   * Scheduled cancel (v1.28.0, P3.8): the contract is inside its plan lock
   * window — the CTA schedules the cancellation for `date` (shop-tz) and the
   * points state exactly what happens: charges/deliveries continue as agreed
   * until then, nothing after, keep anytime before.
   */
  scheduled?: { date: Date; tz: string } | null;
  /**
   * Prepaid contract (v1.28.0, P3.8): only the app-controlled facts are
   * stated — no new charge / no new prepaid term. What happens to
   * deliveries already paid for is Shopify-side fulfilment the app neither
   * controls nor observes, so NO claim is made about them either way.
   */
  prepaid?: boolean;
}): PageContent {
  const { locale, csrf, contractId } = args;
  const preview = args.previewToken ?? null;
  const scheduled = args.scheduled ?? null;
  const concrete = args.summary
    ? lossLines(args.summary, locale, "confirm")
    : [];
  const points = [
    ...(scheduled
      ? [
          t(locale, "cancel.confirm.point_scheduled_until", {
            date: formatShopDate(scheduled.date, scheduled.tz, locale),
          }),
          t(locale, "cancel.confirm.point_scheduled_after"),
        ]
      : [
          t(
            locale,
            args.prepaid
              ? "cancel.confirm.point_no_charges_prepaid"
              : "cancel.confirm.point_no_charges",
          ),
          ...(args.prepaid ? [] : [t(locale, "cancel.confirm.point_no_shipments")]),
        ]),
    // The generic "you lose your price/rewards/progress" point is replaced by
    // the concrete ledger whenever the data proves at least one line.
    ...(concrete.length > 0
      ? concrete
      : [t(locale, "cancel.confirm.point_lose")]),
    t(
      locale,
      scheduled ? "cancel.confirm.point_scheduled_keep" : "cancel.confirm.point_resume",
    ),
  ]
    .map((text) => `<li>${esc(text)}</li>`)
    .join("");

  const finalOptIn = args.finalOfferEligible
    ? `<a class="cxc-center" href="${esc(
        stepAction(contractId, "final", locale, preview),
      )}">${esc(t(locale, "cancel.final.see_offer"))}</a>`
    : "";

  const body = `${EXTRA_STYLE}
${errorHtml(locale, args.showError)}
<p class="cxs-muted">${esc(
    t(locale, scheduled ? "cancel.confirm.what_happens_scheduled" : "cancel.confirm.what_happens"),
  )}</p>
<ul class="cxc-list">${points}</ul>
${postForm(
  stepAction(contractId, "confirm", locale, preview),
  { intent: "confirm_cancel", _csrf: csrf },
  scheduled
    ? t(locale, "cancel.confirm.cta_scheduled", {
        date: formatShopDate(scheduled.date, scheduled.tz, locale),
      })
    : t(locale, "cancel.confirm.cta"),
  true,
)}
<a class="cxs-btn cxs-btn--ghost cxs-btn--full" href="${esc(
    withLocale(portalPublicPath(), locale, preview),
  )}">${esc(t(locale, "cancel.confirm.keep"))}</a>
${finalOptIn}`;

  return {
    title: t(locale, scheduled ? "cancel.confirm.title_scheduled" : "cancel.confirm.title"),
    body,
  };
}

// ── Scheduled (locked contract) ─────────────────────────────────────────────

/**
 * Landing after a scheduled cancel (v1.28.0, P3.8) — and the honest page
 * for a contract that carries a scheduled cancel whenever the customer comes
 * back to /cancel/:id: "cancels on {date}", one full-size "Keep my
 * subscription" button (POST intent=keep_scheduled), portal link. With no
 * scheduled cancel on the contract (just kept, or never scheduled) it says
 * so — nothing changes.
 */
export function pageScheduled(args: {
  locale: string;
  csrf: string;
  contractId: string;
  tz: string;
  /** null ⇒ nothing is scheduled (kept) — render the "you're staying" copy. */
  scheduledAt: Date | null;
  /** The plan lock has lifted since scheduling (lockDays lowered / removed):
   * offer "cancel now instead" — the customer must never have to keep and
   * re-enter the flow to end a subscription they already asked to end. */
  canCancelNow?: boolean;
  /** Preview session's raw cx_pp token — carried on every link/form URL. */
  previewToken?: string | null;
}): PageContent {
  const { locale, csrf, contractId, tz } = args;
  const preview = args.previewToken ?? null;
  const portalCta = `<a class="cxs-btn cxs-btn--full" href="${esc(
    withLocale(portalPublicPath(), locale, preview),
  )}">${esc(t(locale, "cancel.done.portal_cta"))}</a>`;

  if (!args.scheduledAt) {
    return {
      title: t(locale, "cancel.scheduled.kept_title"),
      body: `${EXTRA_STYLE}<p>${esc(t(locale, "cancel.scheduled.kept_body"))}</p>${portalCta}`,
    };
  }
  const date = formatShopDate(args.scheduledAt, tz, locale);
  const body = `${EXTRA_STYLE}
<p>${esc(t(locale, "cancel.scheduled.body", { date }))}</p>
<p class="cxs-muted cxs-small">${esc(t(locale, "cancel.scheduled.reminder_note"))}</p>
${postForm(
  stepAction(contractId, undefined, locale, preview),
  { intent: "keep_scheduled", _csrf: csrf },
  t(locale, "cancel.scheduled.keep_cta"),
  true,
)}
${
  args.canCancelNow
    ? postForm(
        stepAction(contractId, undefined, locale, preview),
        { intent: "cancel_now", _csrf: csrf },
        t(locale, "cancel.scheduled.cancel_now_cta"),
        false,
      )
    : ""
}
${portalCta.replace('class="cxs-btn cxs-btn--full"', 'class="cxs-btn cxs-btn--ghost cxs-btn--full"')}`;
  return { title: t(locale, "cancel.scheduled.title", { date }), body };
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
  /** Resolved support channels (v1.28.0) — real contact buttons, no dead mailto:. */
  support?: SupportChannels;
  /** Education hub links (P4.4) — the guide button after an EDUCATION save. */
  education?: EducationLinks;
}): PageContent {
  const { locale, contractId } = args;
  const preview = args.previewToken ?? null;
  const support = args.support ?? EMPTY_SUPPORT_CHANNELS;
  const education = args.education ?? EMPTY_EDUCATION_LINKS;

  let extras = "";
  if (args.showEducationLinks) {
    extras = `${educationGuideLinkHtml(locale, education)}
${supportChannelsHtml(locale, support, t(locale, "cancel.saves.education.consult_subject"))}`;
  } else if (args.showSupportLink) {
    extras = supportChannelsHtml(
      locale,
      support,
      t(locale, "cancel.saves.support.contact_subject"),
    );
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
