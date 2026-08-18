import { t } from "~/lib/i18n/i18n.server";
import { escapeHtml } from "~/lib/portal/layout.server";
import { paymentMethodShortLabel } from "~/lib/portal/payment.server";
import type { NewCardBannerHit } from "~/lib/dunning/new-method.server";

/**
 * "You have a newer card on file" banner (v1.28.0, P1.8) — ONE markup for
 * the home card and, since v1.29.0, the subscription page in single mode.
 * The one-tap button posts the same payment_select verb the payment-methods
 * list uses (the service re-validates the id); the quiet link opens the
 * payment section. Live statuses only (ACTIVE / PAUSED / FAILED).
 */
export const NEW_CARD_BANNER_STATUSES: readonly string[] = ["ACTIVE", "PAUSED", "FAILED"];

export function newCardBannerText(locale: string, hit: NewCardBannerHit): string {
  const cardLabel = paymentMethodShortLabel(locale, {
    paymentInstrumentType: hit.instrumentType,
    cardBrand: hit.cardBrand,
    cardLast4: hit.cardLast4,
  });
  return cardLabel
    ? t(locale, "portal.index.new_card_banner_labelled", { card: cardLabel })
    : t(locale, "portal.index.new_card_banner");
}

export function newCardBannerHtml(input: {
  locale: string;
  hit: NewCardBannerHit;
  /** Banner sentence (newCardBannerText) — plain text, escaped here. */
  text: string;
  /** The payment_select form (already-escaped HTML). */
  formHtml: string;
  /** Href of the "see payment options" link (portal-relative, escaped here). */
  moreHref: string;
}): string {
  return `<div class="cxs-banner cxs-newcard" data-payment-method="${escapeHtml(input.hit.paymentMethodId)}"><p>${escapeHtml(input.text)}</p>${input.formHtml}<a class="cxs-link cxs-small cxs-newcard__more" href="${escapeHtml(input.moreHref)}">${escapeHtml(t(input.locale, "portal.index.new_card_more"))}</a></div>`;
}
