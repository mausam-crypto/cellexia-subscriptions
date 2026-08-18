import { t } from "~/lib/i18n/i18n.server";
import { formatMoney } from "~/lib/money";
import { formatShopDate, formatShopTime } from "~/lib/dates.server";
import { escapeHtml } from "~/lib/portal/layout.server";
import type { PortalDunningView } from "~/lib/portal/dunning.server";

/**
 * The portal's payment-issue banner (v1.28.0, P1.2): what went wrong, where
 * the case stands, and the one or two things worth doing — by decline
 * category. Copy per state follows the plan verbatim (portal.dunning.*);
 * every CTA is an existing dispatcher verb, so nothing here promises an
 * action the API refuses. Rendered above the schedule card on the detail
 * page. Pure HTML builder — the route hands in its URL/field helpers.
 */

export interface DunningBannerInput {
  locale: string;
  tz: string;
  view: PortalDunningView;
  contract: {
    paymentMethodId: string | null;
    nextBillingDate: Date | null;
  };
  /** Contract status drives which verbs are offered (ACTIVE-only ones). */
  status: string;
  /** Plan lock window — hides the schedule off-ramps the dispatcher refuses. */
  locked: boolean;
  /** Non-revoked payment methods on the customer's account (null = unknown). */
  liveMethodCount: number | null;
  /** dunning.customerRetryCooldownMinutes — hides Retry inside the window. */
  retryCooldownMinutes: number;
  now?: Date;
  /** `/apps/cellexia-subs/api/{action}` with locale/preview carried. */
  apiUrl: (action: string) => string;
  /** Hidden inputs INCLUDING contractId / _csrf / return_to. */
  hiddenFields: (fields: Array<[string, string]>) => string;
  /**
   * "Get help" (v1.28.0, P5.1): anchor of the page's Get-help card (the
   * banner's payment context is preselected there). Omitted ⇒ no link.
   */
  helpHref?: string | null;
  /**
   * "Skip that order and continue from {date}" (v1.28.0, P1.9) — offered on
   * an EXHAUSTED case of a FAILED contract when the card is not hard-dead
   * (revoked / expired / absent ⇒ null: the next charge would only fail
   * again, so update-card is the honest path). The date is the resume date
   * the verb will set (skip-resume.server.ts computeSkipResumeDate) so the
   * promise and the execution agree.
   */
  skipResumeDate?: Date | null;
}

export function dunningBannerHtml(input: DunningBannerInput): string {
  const { locale, tz, view, contract } = input;
  const now = input.now ?? new Date();
  const isActive = input.status === "ACTIVE";
  const isPaused = input.status === "PAUSED";

  const amount =
    view.amountCents != null && view.currencyCode
      ? formatMoney(view.amountCents, view.currencyCode, locale)
      : null;
  const date = formatShopDate(view.failedAt, tz, locale);
  const reason = t(locale, view.reasonKey);
  const title = amount
    ? t(locale, "portal.dunning.title", { amount, date, reason })
    : t(locale, "portal.dunning.title_noamount", { date, reason });

  let stateLine: string;
  if (isPaused) {
    // "We'll pick the payment back up when you resume" is only true for a
    // case the sweep will retry (RETRYING); a case waiting on a card fix
    // (hard decline / revoked) is not retried after resume — say so.
    stateLine =
      view.ctaGroup === "UPDATE_CARD"
        ? t(locale, "portal.dunning.state.paused_update_card")
        : t(locale, "portal.dunning.state.paused");
  } else if (view.state === "RETRYING") {
    stateLine = view.nextRetryAt
      ? t(locale, "portal.dunning.state.retrying", {
          date: formatShopDate(view.nextRetryAt, tz, locale),
        })
      : t(locale, "portal.dunning.state.retrying_soon");
  } else if (view.state === "AWAITING_CUSTOMER") {
    stateLine = t(locale, "portal.dunning.state.awaiting_customer");
  } else if (view.state === "AWAITING_3DS") {
    stateLine = t(locale, "portal.dunning.state.awaiting_3ds");
  } else {
    stateLine = t(locale, "portal.dunning.state.exhausted");
  }

  const btn = (
    action: string,
    label: string,
    fields: Array<[string, string]> = [],
    primary = false,
  ) =>
    `<form method="post" action="${input.apiUrl(action)}" class="cxs-dunning__cta">${input.hiddenFields(fields)}<button type="submit" class="cxs-btn cxs-btn--small${primary ? "" : " cxs-btn--ghost"}">${escapeHtml(label)}</button></form>`;

  const cooldownEndsAt =
    view.customerRetryAt != null
      ? new Date(
          view.customerRetryAt.getTime() + input.retryCooldownMinutes * 60_000,
        )
      : null;
  const inCooldown = cooldownEndsAt != null && now < cooldownEndsAt;
  // Retry: never while paused (Shopify refuses attempts on paused contracts;
  // the paused banner's Resume is the path), never inside the cooldown. The
  // cooldown note is only "waiting for your bank's answer" while an attempt
  // is actually in flight; once its outcome landed (a failed retry lands in
  // seconds) it names when the button comes back instead.
  const cooldownNote = view.inFlight
    ? t(locale, "portal.dunning.retry_cooldown")
    : t(locale, "portal.dunning.retry_again_at", {
        time: cooldownEndsAt ? formatShopTime(cooldownEndsAt, tz, locale) : "",
      });
  const retryCta = isPaused
    ? ""
    : inCooldown
      ? `<span class="cxs-small cxs-muted cxs-dunning__cooldown">${escapeHtml(cooldownNote)}</span>`
      : btn("payment_retry", t(locale, "portal.dunning.retry_now"), [], true);
  const confirmCta = isPaused
    ? ""
    : btn("payment_3ds", t(locale, "portal.dunning.confirm_bank"), [], true);
  const canUpdate = contract.paymentMethodId != null && !view.primaryRevoked;
  const updateCta = canUpdate
    ? btn("payment_update", t(locale, "portal.dunning.update_card"), [], true)
    : `<a class="cxs-btn cxs-btn--small cxs-dunning__cta" href="#cxs-payment">${escapeHtml(t(locale, "portal.dunning.update_card"))}</a>`;
  // "Use another card" whenever the account holds a live method OTHER than
  // the primary: ≥2 live methods, or — the primary being revoked and thus
  // absent from the live list — ≥1 (the very customer whose update-card path
  // is dead; the payment-methods list below shows that same card).
  const otherLiveMethods =
    input.liveMethodCount == null
      ? null
      : view.primaryRevoked
        ? input.liveMethodCount
        : input.liveMethodCount - 1;
  const anotherCta =
    otherLiveMethods != null && otherLiveMethods >= 1
      ? `<a class="cxs-btn cxs-btn--ghost cxs-btn--small cxs-dunning__cta" href="#cxs-payment">${escapeHtml(t(locale, "portal.dunning.use_another_card"))}</a>`
      : "";
  // ACTIVE-only schedule verb (the dispatcher refuses it otherwise, and
  // inside the lock window). Pause is the one SOFT-decline off-ramp the
  // engine honours end-to-end (the whole dunning clock freezes and resume
  // re-enters billing). "Delay 1 week" / "Skip this order" are deliberately
  // NOT offered here: they act on the mirror's nextBillingDate, which after
  // a failed attempt may point at the held cycle OR the following one, so
  // the banner cannot truthfully promise "this order" — the held payment
  // would keep retrying (or the retry would be refused >24h before the new
  // date). A case-aware skip/resume verb is a later stage's work.
  const scheduleCtas =
    isActive && !input.locked
      ? btn("pause", t(locale, "portal.dunning.pause_instead"), [["months", "1"]])
      : "";

  // FAILED (exhausted) contract (P1.9): the third exit — skip the held order
  // and continue from the following date. Case-aware end to end (the verb
  // resolves the case, skips the held cycle on Shopify, reactivates), so it
  // CAN promise "that order" where the plain skip could not.
  const skipResumeCta =
    view.state === "EXHAUSTED" && input.status === "FAILED" && input.skipResumeDate
      ? btn(
          "payment_skip_and_resume",
          t(locale, "portal.dunning.skip_and_resume", {
            date: formatShopDate(input.skipResumeDate, tz, locale),
          }),
        )
      : "";

  let ctas: string;
  if (view.state === "AWAITING_3DS" || view.ctaGroup === "AUTH_REQUIRED") {
    // A challenge to complete → the bank; none pending → the retry.
    ctas = `${view.challenged ? confirmCta : retryCta}${skipResumeCta}`;
  } else if (view.ctaGroup === "UPDATE_CARD") {
    ctas = `${updateCta}${anotherCta}${view.state === "EXHAUSTED" ? retryCta : ""}${skipResumeCta}`;
  } else {
    ctas = `${retryCta}${scheduleCtas}${skipResumeCta}`;
  }

  const backupNote = view.onBackup
    ? `<p class="cxs-small cxs-muted" style="margin:4px 0 0">${escapeHtml(t(locale, "portal.dunning.on_backup"))}</p>`
    : "";
  const helpLink = input.helpHref
    ? `<a class="cxs-btn cxs-btn--quiet cxs-btn--small cxs-dunning__help" href="${escapeHtml(input.helpHref)}">${escapeHtml(t(locale, "portal.dunning.get_help"))}</a>`
    : "";

  return `<div class="cxs-banner cxs-dunning cxs-dunning--${view.state.toLowerCase()}" id="cxs-dunning" role="status" data-case="${escapeHtml(view.caseId)}">
    <div style="flex:1;min-width:200px">
      <p style="margin:0;font-weight:500">${escapeHtml(title)}</p>
      <p class="cxs-small" style="margin:4px 0 0">${escapeHtml(stateLine)}</p>
      ${backupNote}
    </div>
    <div class="cxs-actions" style="margin:0">${ctas}${helpLink}</div>
  </div>`;
}
