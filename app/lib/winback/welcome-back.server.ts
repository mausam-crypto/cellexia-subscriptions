import type { ContractLine, SubscriptionContract } from "@prisma/client";
import { t } from "~/lib/i18n/i18n.server";
import { formatMoney } from "~/lib/money";
import { formatShopDate } from "~/lib/dates.server";
import { escapeHtml } from "~/lib/portal/layout.server";
import type { RetentionSummary } from "~/lib/cancel/summary.server";
import type { WinbackOffer } from "./restart.server";

/**
 * Welcome-back landing content (v1.28.0, P3.5) — pure renderer, no I/O, so
 * the page's truth rules pin in tests. Every line is proven by the summary /
 * offer it is handed: nothing renders on zero / unknown values, and the
 * offer block renders ONLY the offer the engine re-derived (the API applies
 * the same derivation — the page can never promise more than the tap gives).
 */

export interface WelcomeBackInput {
  locale: string;
  tz: string;
  contract: SubscriptionContract & { lines: ContractLine[] };
  summary: RetentionSummary;
  offer: WinbackOffer | null;
  /** The day the first delivery back bills (settings.winback.reactivationBillDelayDays). */
  firstBillAt: Date;
  csrf: string;
  /** Absolute portal path of POST /api/reactivate (locale/preview carried). */
  apiUrl: string;
  /** `return_to` for the API — the detail page, which shows the `restarted` toast. */
  returnTo: string;
  backHref: string;
}

/** The "what's waiting for you" lines, in display order (exported for tests). */
export function welcomeBackPreservedLines(input: {
  locale: string;
  contract: SubscriptionContract & { lines: ContractLine[] };
  summary: RetentionSummary;
}): string[] {
  const { locale, contract, summary } = input;
  const lines: string[] = [];
  const items = contract.lines
    .filter((l) => !l.isGift && !l.isOneTimeAddon)
    .map((l) => (l.quantity > 1 ? `${l.quantity}× ${l.title}` : l.title));
  if (items.length > 0) {
    lines.push(t(locale, "portal.welcome_back.routine", { items: items.join(", ") }));
  }
  if (summary.lockedPrice && summary.lockedPriceCents > 0) {
    lines.push(
      t(locale, "portal.welcome_back.price_locked", {
        price: formatMoney(summary.lockedPriceCents, summary.currencyCode, locale),
      }),
    );
  } else if (summary.perCycleSavingsCents > 0) {
    lines.push(
      t(locale, "portal.welcome_back.price_saving", {
        saving: formatMoney(summary.perCycleSavingsCents, summary.currencyCode, locale),
      }),
    );
  }
  // Milestone progress is kept: ordersCount survives a cancel and the
  // lifecycle engine counts from it on the next successful charge.
  if (summary.nextMilestoneCycle != null && summary.ordersToMilestone > 0) {
    lines.push(
      t(locale, "portal.welcome_back.milestone", {
        orders: summary.ordersCount,
        target: summary.nextMilestoneCycle,
      }),
    );
  }
  if (summary.rewardsUnlocked) {
    lines.push(t(locale, "portal.welcome_back.rewards"));
  }
  if (summary.giftsReceived === 1) {
    lines.push(t(locale, "portal.welcome_back.gifts_one"));
  } else if (summary.giftsReceived > 1) {
    lines.push(
      t(locale, "portal.welcome_back.gifts_many", { count: summary.giftsReceived }),
    );
  }
  return lines;
}

/** The offer sentence for the landing (null = no offer block). */
export function welcomeBackOfferLine(input: {
  locale: string;
  tz: string;
  offer: WinbackOffer | null;
}): string | null {
  const { locale, tz, offer } = input;
  if (!offer) return null;
  const date = formatShopDate(offer.expiresAt, tz, locale);
  if (offer.kind === "DISCOUNT") {
    return t(locale, "portal.welcome_back.offer_discount", {
      percent: offer.percent,
      cycles: offer.cycles,
      date,
    });
  }
  if (!offer.giftTitle) return null; // never promise a gift we cannot name/grant
  return t(locale, "portal.welcome_back.offer_gift", { gift: offer.giftTitle, date });
}

export function welcomeBackHtml(input: WelcomeBackInput): string {
  const { locale, tz, contract, summary, offer } = input;
  const preserved = welcomeBackPreservedLines({ locale, contract, summary });
  const offerLine = welcomeBackOfferLine({ locale, tz, offer });

  const preservedHtml =
    preserved.length > 0
      ? `<div class="cxs-card cxs-welcome__preserved"><h2 style="font-size:18px;margin:0 0 8px">${escapeHtml(t(locale, "portal.welcome_back.preserved_title"))}</h2><ul class="cxs-welcome__list" style="margin:0;padding-left:20px">${preserved
          .map((line) => `<li>${escapeHtml(line)}</li>`)
          .join("")}</ul></div>`
      : "";

  const offerHtml = offerLine
    ? `<div class="cxs-card cxs-welcome__offer" data-cellexia-offer="${escapeHtml(offer!.kind.toLowerCase())}"><h2 style="font-size:18px;margin:0 0 8px">${escapeHtml(t(locale, "portal.welcome_back.offer_title"))}</h2><p>${escapeHtml(offerLine)}</p></div>`
    : "";

  const firstDelivery = t(locale, "portal.welcome_back.first_delivery", {
    date: formatShopDate(input.firstBillAt, tz, locale),
  });

  const hidden = [
    ["contractId", contract.id],
    ["_csrf", input.csrf],
    ["return_to", input.returnTo],
  ]
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join("");

  return `<div class="cxs-welcome">
  <p class="cxs-welcome__intro">${escapeHtml(t(locale, "portal.welcome_back.intro"))}</p>
  ${preservedHtml}
  ${offerHtml}
  <div class="cxs-card cxs-welcome__action">
    <p class="cxs-small cxs-muted">${escapeHtml(firstDelivery)}</p>
    <form method="post" action="${escapeHtml(input.apiUrl)}" class="cxs-welcome__form">${hidden}<button type="submit" class="cxs-btn cxs-btn--full cxs-welcome__restart">${escapeHtml(t(locale, "portal.actions.restart"))}</button></form>
    <p class="cxs-small cxs-muted">${escapeHtml(t(locale, "portal.welcome_back.no_commitment"))}</p>
    <p class="cxs-small"><a class="cxs-muted" href="${escapeHtml(input.backHref)}">${escapeHtml(t(locale, "portal.welcome_back.back"))}</a></p>
  </div>
</div>`;
}
