import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import type { ContractStatus } from "@prisma/client";
import prisma from "~/db.server";
import { authenticate, adminClientForShop } from "~/shopify.server";
import { requireShop } from "~/lib/shop/install.server";
import { getSetting } from "~/lib/settings/settings.server";
import { t } from "~/lib/i18n/i18n.server";
import { formatMoney } from "~/lib/money";
import { formatShopDate, shopDayStartUtc } from "~/lib/dates.server";
import { isSetupMode } from "~/lib/launch/launch.server";
import { logEvent } from "~/lib/events/log.server";
import {
  escapeHtml,
  localeFromRequest,
  portalPage,
  resolveToast,
  closedPortalPage,
  withLocale,
  type PortalToast,
} from "~/lib/portal/layout.server";
import {
  PORTAL_BASE_PATH,
  exchangeLoginHandoff,
  getPortalSession,
  loginRedirectUrl,
  type PortalSessionContext,
} from "~/lib/portal/session.server";
import type { LocalContractWithLines } from "~/lib/contracts/shared.server";
import { contractFrequency, formatFrequency } from "~/lib/frequency";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";
import { getLockRules, lockStateFor } from "~/lib/contracts/lock.server";
import { memberSavingsCents, milestoneRemaining } from "~/lib/portal/growth.server";
import { rewardsSectionHtml } from "~/lib/portal/rewards-card.server";
import {
  homeReturnTo,
  singleSubscriptionRedirectPath,
} from "~/lib/portal/single-subscription.server";
import {
  resolveTimeline,
  resolveTimelineArm,
  timelineLineHtml,
  timelinePosition,
} from "~/lib/portal/timeline.server";
import {
  inTransitLineHtml,
  latestDeliveryByContract,
  latestInTransit,
} from "~/lib/portal/deliveries.server";
import { safeHandoffNext } from "~/lib/portal/handoff-next.server";
import {
  dunningSortRank,
  loadPortalDunningMany,
  logDunningBannerShown,
  type PortalDunningView,
} from "~/lib/portal/dunning.server";
import {
  derivePortalPaymentState,
  paymentChipKey,
  type PortalPaymentView,
} from "~/lib/portal/payment.server";
import { newCardBannerHtml, newCardBannerText } from "~/lib/portal/new-card-banner.server";
import { newCardBannerHits, type NewCardBannerHit } from "~/lib/dunning/new-method.server";
import { listLivePaymentMethodsCached } from "~/lib/portal/payment-methods.server";
import { getActiveDiscountForCycle } from "~/lib/billing/discounts.server";
import type { NextChargeEstimate } from "~/lib/billing/estimate.server";
import { resolveChargeTiming } from "~/lib/billing/timing.server";
import {
  contractCutoff,
  cutoffLabel,
  preparingOrderDateByContract,
  safeEstimateNextCharge,
} from "~/lib/portal/next-delivery.server";
import { renderIntentBanner } from "~/lib/cancel/intent-banner.server";
import { getSupportChannels } from "~/lib/support/channels.server";
import { hasFurtherOrders } from "~/lib/cancel/further-orders";

/**
 * Portal home: every subscription the signed-in customer has, with one-tap
 * quick actions, a rewards strip (days subscribed, milestone progress,
 * rewards unlock) and a contextual "push it back" prompt for subscribers who
 * are predicted to still have product when the next order would bill.
 *
 * Also the landing point of the magic-link LOGIN hand-off: ?handoff= carries
 * a single-use ~60s code that is exchanged server-side for the HttpOnly
 * cx_portal session cookie, then redirected away to a clean URL.
 */

const STATUS_ORDER: Record<ContractStatus, number> = {
  ACTIVE: 0,
  PAUSED: 1,
  FAILED: 2,
  CANCELLED: 3,
  EXPIRED: 4,
};

const STATUS_CHIP_CLASS: Record<ContractStatus, string> = {
  ACTIVE: "cxs-chip--active",
  PAUSED: "cxs-chip--paused",
  FAILED: "cxs-chip--failed",
  CANCELLED: "cxs-chip--cancelled",
  EXPIRED: "cxs-chip--expired",
};

function apiPath(
  locale: string,
  action: string,
  preview: string | null,
): string {
  return withLocale(`${PORTAL_BASE_PATH}/api/${action}`, locale, preview);
}

interface FormField {
  name: string;
  value: string;
}

function postForm(
  actionUrl: string,
  fields: FormField[],
  buttonLabel: string,
  buttonClass = "cxs-btn cxs-btn--ghost cxs-btn--small",
): string {
  const hidden = fields
    .map(
      (f) =>
        `<input type="hidden" name="${escapeHtml(f.name)}" value="${escapeHtml(f.value)}">`,
    )
    .join("");
  return `<form method="post" action="${escapeHtml(actionUrl)}">${hidden}<button type="submit" class="${buttonClass}">${escapeHtml(buttonLabel)}</button></form>`;
}

/**
 * The card's line rows come from THE next-order estimate (P2.4 / P2.5): a
 * line the customer marked "not this time" is struck through and bills 0, a
 * one-order quantity tweak shows the billed count "(usually N)", so the
 * visible rows − discount + delivery always add up to the card's total.
 * (Rendering the mirror's plan quantity × price used to list a skipped
 * product as shipping and sum to a different number than the total.)
 */
function itemsHtml(
  contract: Pick<LocalContractWithLines, "currencyCode">,
  locale: string,
  estimate: Pick<NextChargeEstimate, "lines" | "currency">,
): string {
  const currency = estimate.currency || contract.currencyCode;
  return estimate.lines
    .filter((line) => line.kind !== "scheduled_gift")
    .map((line) => {
      const thumb = line.imageUrl
        ? `<img class="cxs-thumb" src="${escapeHtml(line.imageUrl)}" alt="" loading="lazy">`
        : `<div class="cxs-thumb cxs-thumb--placeholder">C</div>`;
      const badges: string[] = [];
      if (line.kind === "gift") badges.push(t(locale, "portal.item.gift"));
      if (line.kind === "one_time_addon") badges.push(t(locale, "portal.item.one_time"));
      if (line.skippedThisCycle) badges.push(t(locale, "portal.next.not_this_time"));
      if (line.planQuantity != null && !line.skippedThisCycle) {
        badges.push(t(locale, "portal.next.qty_once", { plan: line.planQuantity }));
      }
      const meta = [
        line.variantTitle && line.variantTitle !== "Default Title"
          ? line.variantTitle
          : null,
        t(locale, "portal.item.quantity", { quantity: line.quantity }),
        ...badges,
      ]
        .filter(Boolean)
        .join(" · ");
      const price = line.free
        ? escapeHtml(t(locale, "portal.item.free"))
        : escapeHtml(formatMoney(line.lineTotalCents, currency, locale));
      const skippedCls = line.skippedThisCycle ? " cxs-item--skipped" : "";
      const titleHtml = line.skippedThisCycle
        ? `<s>${escapeHtml(line.title)}</s>`
        : escapeHtml(line.title);
      return `<div class="cxs-item${skippedCls}">${thumb}<div class="cxs-item__body"><p class="cxs-item__title">${titleHtml}</p><p class="cxs-item__meta">${escapeHtml(meta)}</p></div><span class="cxs-price">${price}</span></div>`;
    })
    .join("");
}

function contractCardHtml(params: {
  contract: LocalContractWithLines;
  locale: string;
  tz: string;
  csrf: string;
  /** Preview session's raw cx_pp token — carried on every link/form URL. */
  preview: string | null;
  contextualPrompts: boolean;
  /** Prompt only when predicted-empty is this many days past the next bill. */
  promptBufferDays: number;
  /** Weeks the contextual one-tap delay pushes the next order back. */
  promptDelayWeeks: number;
  /** Plan lock window — hides the one-tap skip/delay while it runs. */
  locked: boolean;
  /** portalGrowth.homeValueCard — value-first card (v1.20.0). */
  valueCard: boolean;
  /** Money-true captured member savings for this contract (0 = hide tile). */
  savedCents: number;
  /** Deliveries to the milestone gift; null = off/reached. */
  milestoneAway: number | null;
  /** Payment issue (v1.28.0): the contract's open / exhausted dunning case. */
  dunning: PortalDunningView | null;
  /** Mirrored payment method state (v1.28.0, P1.5): chip + next-charge line. */
  payment: PortalPaymentView;
  /**
   * THE next-order estimate (v1.28.0, P2.4) — the discounted total the
   * hero, the reminder and this card all state. No money is computed here.
   */
  estimate: NextChargeEstimate;
  /** editCutoff(nextBillingDate) — "changes until {date}" (null = none). */
  cutoff: Date | null;
  /** Billing day reached / attempt in flight (P2.1): chip + no one-taps. */
  preparing: boolean;
  /**
   * The order date being prepared (`preparingOrderDate`) — while an attempt
   * is in flight the mirror's nextBillingDate is already the FOLLOWING cycle,
   * so the card prints this date instead. Optional; null = mirror date.
   */
  preparingOrderDate?: Date | null;
  /**
   * Results timeline compact line (v1.28.0, P4.1 — portalGrowth.resultsTimeline
   * + the results_timeline experiment's "shown" arm): pre-rendered HTML or "".
   */
  timelineLine?: string;
  /**
   * "On its way · Track" (v1.28.0, P4.2 — portalGrowth.deliveriesList): the
   * newest shipped-not-delivered order's one-liner, pre-rendered HTML or "".
   */
  inTransitLine?: string;
  /**
   * "You have a newer card on file" (v1.28.0, P1.8): the method the
   * new_card_detected notice named, still not this contract's primary — one
   * tap posts payment_select (the service re-validates the id). Null = none.
   */
  newCard?: NewCardBannerHit | null;
  /**
   * `return_to` for this page (v1.29.0): "/" or "/?list=1" when the page is
   * the explicit list — a single-subscription customer stays on the list
   * after a card action instead of bouncing to the detail page.
   */
  returnTo?: string;
}): string {
  const { contract, locale, tz, csrf, preview, dunning } = params;
  const returnTo = params.returnTo ?? "/";
  const api = (action: string) => apiPath(locale, action, preview);
  // Server-side double-submit dedupe: one-tap forms carry the cycle date they
  // target, so a duplicate POST for an already-advanced cycle is a no-op.
  const expectedNext = contract.nextBillingDate?.toISOString() ?? "";
  const manageHref = withLocale(
    `${PORTAL_BASE_PATH}/subscription/${contract.id}`,
    locale,
    preview,
  );
  const baseFields: FormField[] = [
    { name: "contractId", value: contract.id },
    { name: "_csrf", value: csrf },
    { name: "return_to", value: returnTo },
  ];

  const statusLabel = t(
    locale,
    `portal.status.${contract.status.toLowerCase()}`,
  );
  // ACTIVE with an open case (v1.28.0): the chip says "Payment issue" (today
  // keyed on status alone, so a held order looked healthy for weeks) and the
  // header names the hold instead of promising a next order.
  const activeIssue = contract.status === "ACTIVE" && dunning != null;
  // Card chip (v1.28.0, P1.5): "Card expiring" / "Card expired" / "Card
  // removed" from the mirrored method state — the payment-issue chip wins.
  const cardChip = paymentChipKey(params.payment.state, {
    status: contract.status,
    hasIssue: dunning != null,
  });
  // Preparing (P2.1): billing day reached — the chip says so and the
  // one-tap skip/delay leave the card (the api action is the backstop).
  const preparing = params.preparing && contract.status === "ACTIVE" && !activeIssue;
  const chipClass = activeIssue
    ? "cxs-chip--failed"
    : cardChip
      ? params.payment.state === "EXPIRING"
        ? "cxs-chip--warn"
        : "cxs-chip--failed"
      : preparing
        ? "cxs-chip--warn cxs-next__preparing"
        : STATUS_CHIP_CLASS[contract.status];
  const chipLabel = activeIssue
    ? t(locale, "portal.dunning.chip")
    : cardChip
      ? t(locale, cardChip)
      : preparing
        ? t(locale, "portal.next.preparing_chip")
        : statusLabel;
  // The DISCOUNTED total from the shared estimate (P2.4 money-true rule).
  const total = formatMoney(
    params.estimate.totalCents,
    contract.currencyCode,
    locale,
  );
  // The line rows print the estimate's effective lines (skips / one-order
  // quantities applied); when a grant applies, the discount row reconciles
  // them with the total (as the detail page does) so the customer's own
  // arithmetic never disagrees with the card.
  const discountRowHtml =
    params.estimate.discountCents > 0 && params.estimate.discountLabel
      ? `<div class="cxs-row cxs-row--between cxs-small cxs-next__discount" style="margin-top:4px"><span>${escapeHtml(params.estimate.discountLabel)}</span><span>${escapeHtml(`−${formatMoney(params.estimate.discountCents, contract.currencyCode, locale)}`)}</span></div>`
      : "";

  // Scheduled cancel whose end falls before the mirror's next pointer: the
  // sweep will never bill that order (further-orders.ts) — "Next order
  // {date} · {amount}" would be a false promise. The card says so instead.
  const noFurtherOrders =
    contract.status !== "CANCELLED" &&
    contract.cancelScheduledAt != null &&
    !hasFurtherOrders(contract);
  let scheduleHtml = "";
  if (activeIssue && dunning) {
    scheduleHtml = `<div><span class="cxs-label">${escapeHtml(t(locale, "portal.dunning.held_since"))}</span><strong>${escapeHtml(formatShopDate(dunning.openedAt, tz, locale))}</strong></div>`;
  } else if (noFurtherOrders && contract.cancelScheduledAt) {
    scheduleHtml = `<div><span class="cxs-label">${escapeHtml(t(locale, "portal.index.cancels_on"))}</span><strong>${escapeHtml(formatShopDate(contract.cancelScheduledAt, tz, locale))}</strong><p class="cxs-muted cxs-small cxs-no-further-orders" style="margin:4px 0 0">${escapeHtml(t(locale, "portal.index.no_further_orders"))}</p></div>`;
  } else if (contract.status === "ACTIVE" && contract.nextBillingDate) {
    // Next-charge line (P1.5): "{amount} on {date} · Visa ····4242" — the
    // reminder's estimate (plan pricing − live grant + delivery), so the
    // figure framed as "what will be charged" is the same one the upcoming-
    // order email states. The card label is the estimate's too: revoke-aware
    // (blank once the card was removed — the chip already says so) and
    // brand-capitalised, so the home line, the hero and the reminder agree.
    // Under "Preparing" with an attempt in flight the mirror's pointer is
    // already the following cycle: print the order being prepared instead
    // (the estimate's lines/total describe that order).
    const shownDate =
      preparing &&
      params.preparingOrderDate != null &&
      params.preparingOrderDate.getTime() < contract.nextBillingDate.getTime()
        ? params.preparingOrderDate
        : contract.nextBillingDate;
    const nextDate = formatShopDate(shownDate, tz, locale);
    // v1.29.0: the heading already IS the date, so the subline is
    // "{amount} · Visa ····4242" (card label only when known) — the date is
    // never repeated. Same estimate + card label as before.
    const chargeLine = [total, params.estimate.cardLabel || null]
      .filter(Boolean)
      .join(" · ");
    // Cut-off (P2.1): "Changes until {date, time}" — the charge moment the
    // sweep reads, rendered by the shared formatter (an hour-0 moment reads
    // as the end of the previous day); while preparing, the chip carries the
    // state instead.
    const cutoffLine =
      params.cutoff && !preparing
        ? `<p class="cxs-muted cxs-small cxs-next__cutoff" style="margin:2px 0 0">${escapeHtml(t(locale, "portal.next.cutoff_short", { cutoff: cutoffLabel(locale, params.cutoff, tz) }))}</p>`
        : "";
    scheduleHtml = `<div class="cxs-next__block"><span class="cxs-label">${escapeHtml(t(locale, "portal.index.next_order"))}</span><strong>${escapeHtml(nextDate)}</strong><p class="cxs-muted cxs-small cxs-next-charge" style="margin:4px 0 0">${escapeHtml(chargeLine)}</p>${cutoffLine}</div>`;
  } else if (contract.status === "PAUSED" && contract.resumeAt) {
    scheduleHtml = `<div><span class="cxs-label">${escapeHtml(t(locale, "portal.index.resumes"))}</span><strong>${escapeHtml(formatShopDate(contract.resumeAt, tz, locale))}</strong></div>`;
  } else {
    scheduleHtml = `<div><span class="cxs-label">${escapeHtml(t(locale, "portal.index.status_label"))}</span><strong>${escapeHtml(statusLabel)}</strong></div>`;
  }
  // Scheduled cancel (v1.28.0, P3.8): the card says so under the schedule
  // ("Cancels on {date}"); the detail page carries the keep button.
  if (contract.cancelScheduledAt && contract.status !== "CANCELLED" && !noFurtherOrders) {
    scheduleHtml += `<p class="cxs-muted cxs-small cxs-cancel-scheduled" style="margin:4px 0 0">${escapeHtml(t(locale, "portal.index.cancels_on"))} ${escapeHtml(formatShopDate(contract.cancelScheduledAt, tz, locale))}</p>`;
  }

  let promptHtml = "";
  if (
    params.contextualPrompts &&
    !params.locked &&
    !preparing &&
    contract.status === "ACTIVE" &&
    contract.nextBillingDate &&
    contract.predictedEmptyDate &&
    contract.predictedEmptyDate.getTime() >
      contract.nextBillingDate.getTime() +
        params.promptBufferDays * 24 * 3600_000
  ) {
    // The run-out prompt's rationale is THIS order's stock ("not running
    // low?") — it posts mode=once so a tap never re-anchors every later
    // order (review fix; the toast and Undo follow the once semantics).
    promptHtml = `<div class="cxs-banner"><p>${escapeHtml(t(locale, "portal.index.contextual_prompt"))}</p>${postForm(
      api("delay"),
      [
        ...baseFields,
        { name: "weeks", value: String(params.promptDelayWeeks) },
        { name: "mode", value: "once" },
        { name: "expected_next", value: expectedNext },
      ],
      t(locale, "portal.index.contextual_prompt_cta"),
    )}</div>`;
  }

  // Newer card on file (P1.8): rendered above the value grid so a payment
  // fix outranks growth copy; the button is the same payment_select verb the
  // detail page's list uses, the quiet link opens the payment section.
  let newCardHtml = "";
  if (params.newCard && ["ACTIVE", "PAUSED", "FAILED"].includes(contract.status)) {
    // Shared markup (new-card-banner.server.ts) — the subscription page
    // renders the same banner in single mode (v1.29.0). Keys:
    // portal.index.new_card_banner_labelled / portal.index.new_card_banner.
    newCardHtml = newCardBannerHtml({
      locale,
      hit: params.newCard,
      text: newCardBannerText(locale, params.newCard),
      formHtml: postForm(
        api("payment_select"),
        [...baseFields, { name: "paymentMethodId", value: params.newCard.paymentMethodId }],
        t(locale, "portal.index.new_card_cta"),
        "cxs-btn cxs-btn--small",
      ),
      moreHref: `${manageHref}#cxs-payment`,
    });
  }

  // Value-first card (portalGrowth.homeValueCard, v1.20.0): the list card
  // leads with what the membership has EARNED — money-true captured savings
  // (endowment) and milestone proximity (goal gradient) — and its actions
  // are add-products + manage. One-tap skip/delay disappear from here (a
  // button on every visit is an advertisement for skipping — availability
  // priming), but both remain two calm taps away on the Manage page: the
  // salience changes, the capability never does.
  const valueCard = params.valueCard && contract.status === "ACTIVE";
  let valueHtml = "";
  if (valueCard) {
    // v1.29.0: uniform tiles (.cxs-value__*) — one number style, one label
    // style; the member-since date is a compact value, not a display date.
    const tile = (num: string, label: string, numClass = "") =>
      `<div class="cxs-value__cell"><div class="cxs-value__num${numClass}">${num}</div><div class="cxs-muted cxs-small cxs-value__label">${escapeHtml(label)}</div></div>`;
    const cells: string[] = [];
    if (params.savedCents > 0) {
      cells.push(
        tile(
          escapeHtml(formatMoney(params.savedCents, contract.currencyCode, locale)),
          t(locale, "portal.value.saved"),
        ),
      );
    }
    cells.push(
      tile(
        escapeHtml(formatShopDate(contract.firstChargeAt ?? contract.createdAt, tz, locale)),
        t(locale, "portal.value.member_since"),
        " cxs-value__num--date",
      ),
    );
    if (params.milestoneAway != null) {
      // Proper pluralisation: one key per form, selected by the count.
      cells.push(
        tile(
          String(params.milestoneAway),
          t(
            locale,
            params.milestoneAway === 1
              ? "portal.value.milestone_away_one"
              : "portal.value.milestone_away_other",
          ),
        ),
      );
    }
    valueHtml = `<div class="cxs-value" style="margin-top:12px">${cells.join("")}</div>`;
  }
  // "Week N of your routine" line rides under the value grid on ACTIVE cards
  // only — the timeline is about a routine that is running.
  if (contract.status === "ACTIVE" && params.timelineLine) {
    valueHtml += params.timelineLine;
  }

  const actions: string[] = [];
  // Lock window: the one-tap skip/delay are hidden while it runs (the api
  // action refuses them server-side regardless) — the manage link below
  // stays, and the detail page explains the window with its unlock date.
  if (contract.status === "ACTIVE" && valueCard) {
    actions.push(
      `<a class="cxs-btn cxs-btn--small" href="${manageHref}#cxs-add">${escapeHtml(t(locale, "portal.actions.add_products"))}</a>`,
    );
  } else if (contract.status === "ACTIVE" && !params.locked && !preparing) {
    actions.push(
      postForm(
        api("skip"),
        [...baseFields, { name: "expected_next", value: expectedNext }],
        t(locale, "portal.actions.skip"),
      ),
    );
    actions.push(
      postForm(
        api("delay"),
        [
          ...baseFields,
          { name: "weeks", value: "1" },
          { name: "expected_next", value: expectedNext },
        ],
        t(locale, "portal.actions.delay_1w"),
      ),
    );
  }
  if (contract.status === "PAUSED") {
    actions.push(
      postForm(
        api("resume"),
        baseFields,
        t(locale, "portal.actions.resume"),
        "cxs-btn cxs-btn--small",
      ),
    );
  }
  if (dunning && (contract.status === "FAILED" || activeIssue)) {
    // Payment issue (v1.28.0): the primary action IS fixing the payment —
    // straight to the detail banner, which carries the category-specific
    // verbs (retry / update / confirm with the bank).
    actions.push(
      `<a class="cxs-btn cxs-btn--small cxs-dunning__fix" href="${manageHref}#cxs-dunning">${escapeHtml(t(locale, "portal.dunning.fix_payment"))}</a>`,
    );
  }
  if (contract.status === "CANCELLED" && contract.cancelReason !== "MERGED") {
    // A cancelled subscription must never be a dead end (a MERGED source is
    // the exception: its lines continue in the primary contract, restarting
    // it would double-bill — no Restart door): Restart opens the
    // welcome-back landing (v1.28.0, P3.5 — what is preserved + the CURRENT
    // win-back offer, re-derived server-side), one tap from there through
    // the win-back reactivation service.
    actions.push(
      `<a class="cxs-btn cxs-btn--small" href="${withLocale(`${PORTAL_BASE_PATH}/subscription/${contract.id}/restart`, locale, preview)}">${escapeHtml(t(locale, "portal.actions.restart"))}</a>`,
    );
  }
  actions.push(
    `<a class="cxs-btn cxs-btn--quiet cxs-btn--small" href="${manageHref}">${escapeHtml(t(locale, "portal.actions.manage"))}</a>`,
  );

  // contractFrequency: exact unit/count mirror when present, else the
  // intervalWeeks approximation as a WEEK cadence.
  const frequency = t(locale, "portal.index.every_weeks", {
    frequency: formatFrequency(
      (key, vars) => t(locale, key, vars),
      "every",
      contractFrequency(contract),
    ),
  });
  return `<section class="cxs-card">
  <div class="cxs-row cxs-row--between" style="margin-bottom:14px">
    <p class="cxs-muted cxs-small" style="margin:0">${escapeHtml(frequency)}</p>
    <span class="cxs-chip ${chipClass}">${escapeHtml(chipLabel)}</span>
  </div>
  ${itemsHtml(contract, locale, params.estimate)}
  ${discountRowHtml}
  <hr class="cxs-divider">
  <div class="cxs-row cxs-row--between cxs-row--wrap">
    ${scheduleHtml}
    <div><span class="cxs-label">${escapeHtml(t(locale, "portal.index.order_total"))}</span><strong class="cxs-price">${escapeHtml(total)}</strong></div>
  </div>
  ${params.inTransitLine ?? ""}
  ${newCardHtml}
  ${valueHtml}
  ${promptHtml}
  <div class="cxs-actions">${actions.join("")}</div>
</section>`;
}

async function buildToast(
  request: Request,
  locale: string,
  session: PortalSessionContext,
  contractIds: Set<string>,
): Promise<PortalToast | null> {
  // Undo context (v1.28.0, P2.2): delayed / date_changed / frequency_changed
  // toasts carry a signed undo token — rendered as a form only for a
  // contract this page lists, with this session's CSRF.
  const resolved = resolveToast(request, locale, {
    csrfToken: session.csrfToken,
    previewToken: session.previewToken,
    contractIds,
  });
  if (!resolved) return null;

  // "Order skipped" carries a one-tap undo for the affected contract.
  if (resolved.key === "skipped") {
    const cid = new URL(request.url).searchParams.get("cid");
    if (cid && contractIds.has(cid)) {
      resolved.toast.html = `<form method="post" action="${apiPath(locale, "unskip", session.previewToken)}"><input type="hidden" name="contractId" value="${escapeHtml(cid)}"><input type="hidden" name="_csrf" value="${escapeHtml(session.csrfToken)}"><input type="hidden" name="return_to" value="${escapeHtml(homeReturnTo(new URL(request.url)))}"><button type="submit">${escapeHtml(t(locale, "portal.toast.undo"))}</button></form>`;
    }
  }
  return resolved.toast;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { liquid, session } = await authenticate.public.appProxy(request);
  if (!session) throw new Response("Unauthorized", { status: 401 });
  const locale = localeFromRequest(request);
  const shop = await requireShop(session.shop);

  // ── Magic-link LOGIN hand-off ──────────────────────────────────────────────
  // ?handoff= is a single-use ~60s code minted by the magic LOGIN executor.
  // Exchange it server-side for the HttpOnly cx_portal cookie, then redirect
  // to a clean URL so the code never lingers in the address bar. The
  // long-lived session token itself never appears in any URL. A ?cx_pp=
  // preview token riding alongside (pre-1.7.0 preview links) survives the
  // clean-up — on a live store the proxy strips the Set-Cookie, so that
  // token is the only identity that reaches the next request. A failed
  // exchange without one lands on the login page with a named reason
  // (?signin=expired) instead of silently gating.
  const requestUrl = new URL(request.url);
  const handoffCode = requestUrl.searchParams.get("handoff");
  if (handoffCode) {
    const previewToken = requestUrl.searchParams.get("cx_pp");
    // Optional in-portal landing (v1.28.0, CHECKIN): a strictly validated
    // relative subscription path with whitelisted query keys — anything else
    // lands on the home page as before.
    const nextPath = safeHandoffNext(requestUrl.searchParams.get("next"));
    const cleanUrl = withLocale(`${PORTAL_BASE_PATH}${nextPath ?? "/"}`, locale, previewToken);
    const handoff = await exchangeLoginHandoff(handoffCode, shop.id);
    if (!handoff && !previewToken) {
      throw redirect(
        withLocale(`${PORTAL_BASE_PATH}/login?signin=expired`, locale),
      );
    }
    throw redirect(
      cleanUrl,
      handoff ? { headers: { "Set-Cookie": handoff.cookie } } : undefined,
    );
  }

  // Sessionless (or wrong-shop) → login via loginRedirectUrl, which carries
  // the request's ?cx_pp= along. The portal home is the EXACT URL the admin
  // preview mints, so an expired preview token lands here first — dropping
  // it would show the generic setup gate instead of "this preview link has
  // expired" (the dead-end this release removes).
  const portalSession = await getPortalSession(request);
  if (!portalSession) {
    throw redirect(loginRedirectUrl(request));
  }
  if (portalSession.shopId !== shop.id) {
    throw redirect(loginRedirectUrl(request));
  }

  // Launch gate: while in setup mode the portal is closed to the public —
  // only admin preview sessions pass through. closedPortalPage names an
  // expired ?cx_pp= instead of gating it silently.
  if (!portalSession.isPreview && (await isSetupMode(shop.id))) {
    return liquid(closedPortalPage(request, locale), {
      headers: { "X-Robots-Tag": "noindex" },
    });
  }

  // portal.visit — the portal's own reach datum (actions were logged, plain
  // visits were not, so "how many subscribers even open the portal" was
  // unanswerable). Once per session per shop-day; server-side only, no PII
  // beyond the session's own identity; no contractId so contract timelines
  // stay action-only. Admin previews are not customers. Contained: a failed
  // throttle read must never break the page.
  if (!portalSession.isPreview) {
    try {
      const dayStart = shopDayStartUtc(new Date(), shop.ianaTimezone);
      const already = await prisma.subscriberEvent.findFirst({
        where: {
          shopId: shop.id,
          type: "portal.visit",
          createdAt: { gte: dayStart },
          payload: { path: ["sessionId"], equals: portalSession.id },
        },
        select: { id: true },
      });
      if (!already) {
        await logEvent({
          shopId: shop.id,
          customerId: portalSession.customerId,
          email: portalSession.email,
          type: "portal.visit",
          source: "CUSTOMER_PORTAL",
          actor: "customer",
          payload: { sessionId: portalSession.id },
        });
      }
    } catch (err) {
      console.error("[portal] visit event failed", err);
    }
  }

  const [contracts, portalSettings, lifecycle, growth, lockRules, dunningSettings] =
    await Promise.all([
    prisma.subscriptionContract.findMany({
      // OURS_ONLY: a customer who also subscribes through the store's other
      // subscription app must never see (let alone manage) that contract here.
      where: {
        shopId: shop.id,
        customerId: portalSession.customerId,
        ...OURS_ONLY,
      },
      include: { lines: true },
      orderBy: { createdAt: "desc" },
    }),
    getSetting(shop.id, "portal"),
    getSetting(shop.id, "lifecycle"),
    getSetting(shop.id, "portalGrowth"),
    // Plan lock window rules, fetched once and applied per contract card.
    getLockRules(shop.id),
    // dunning.preExpiryNoticeDays drives the "Card expiring" chip.
    getSetting(shop.id, "dunning"),
  ]);

  // Single-subscription view (v1.29.0, portal.singleSubscriptionOpensDetail):
  // exactly one contract (any status) ⇒ open it directly, forwarding the
  // query (toasts / undo / cid / locale / cx_pp) — `?list=1` keeps the list.
  // Same guard chain as the list (auth, shop, setup gate, visit event) —
  // preview sessions follow it too: the preview shows what the customer sees,
  // and the list stays one tap away through the nav tab.
  {
    const singlePath = singleSubscriptionRedirectPath({
      requestUrl: requestUrl,
      enabled: portalSettings.singleSubscriptionOpensDetail,
      contractIds: contracts.map((c) => c.id),
    });
    if (singlePath) throw redirect(singlePath);
  }

  // Payment issues (v1.28.0): open case on an ACTIVE/PAUSED contract, or the
  // exhausted case of a FAILED one — read once for the page. Contained: a
  // failed read renders the classic cards.
  let dunningByContract = new Map<string, PortalDunningView>();
  try {
    dunningByContract = await loadPortalDunningMany(contracts);
  } catch (err) {
    console.error("[portal] dunning views failed", err);
  }
  contracts.sort(
    (a, b) =>
      dunningSortRank(dunningByContract.has(a.id), STATUS_ORDER[a.status]) -
      dunningSortRank(dunningByContract.has(b.id), STATUS_ORDER[b.status]),
  );

  const toast = await buildToast(
    request,
    locale,
    portalSession,
    new Set(contracts.map((c) => c.id)),
  );

  let body = "";
  if (contracts.length === 0) {
    body = `<div class="cxs-card"><p style="margin:0 0 8px">${escapeHtml(t(locale, "portal.index.empty_title"))}</p><p class="cxs-muted cxs-small" style="margin:0">${escapeHtml(t(locale, "portal.index.empty_body"))}</p></div>`;
  } else {
    // The rewards card (strip / roadmap) — the shared builder the
    // subscription page renders in single mode too (v1.29.0).
    body += await rewardsSectionHtml({
      shopId: shop.id,
      tz: shop.ianaTimezone,
      locale,
      customerId: portalSession.customerId,
      contracts,
      lifecycle,
      growth,
    });

    // Results timeline compact line (v1.28.0, P4.1): per ACTIVE contract,
    // behind portalGrowth.resultsTimeline + lifecycle.resultsTimeline.enabled
    // + the results_timeline "shown" arm (the arm is per customer; resolved
    // once and recorded as exposure only when a card would actually render).
    const timelineLines = new Map<string, string>();
    if (growth.resultsTimeline && !portalSession.isPreview) {
      try {
        const timeline = await resolveTimeline(shop.id, locale);
        if (timeline.enabled) {
          const active = contracts.filter((c) => c.status === "ACTIVE" && !c.isDemo);
          if (active.length > 0) {
            const arm = await resolveTimelineArm(active[0]);
            if (arm === "shown") {
              const now = new Date();
              for (const c of active) {
                const pos = timelinePosition(timeline, c, now, shop.ianaTimezone);
                if (pos) timelineLines.set(c.id, timelineLineHtml(locale, pos));
              }
            }
          }
        }
      } catch (err) {
        console.error("[portal] results timeline (home) failed", err);
      }
    } else if (growth.resultsTimeline && portalSession.isPreview) {
      // Admin preview: render the line without touching the experiment.
      try {
        const timeline = await resolveTimeline(shop.id, locale);
        if (timeline.enabled) {
          const now = new Date();
          for (const c of contracts) {
            if (c.status !== "ACTIVE") continue;
            const pos = timelinePosition(timeline, c, now, shop.ianaTimezone);
            if (pos) timelineLines.set(c.id, timelineLineHtml(locale, pos));
          }
        }
      } catch (err) {
        console.error("[portal] results timeline (preview) failed", err);
      }
    }

    // "On its way · Track" (v1.28.0, P4.2, portalGrowth.deliveriesList): one
    // batched read of each contract's newest charge; the line renders only
    // while that order is shipped, not delivered and within the in-transit
    // window (portal.deliveriesInTransitMaxDays). Contained.
    const inTransitLines = new Map<string, string>();
    if (growth.deliveriesList) {
      try {
        const latest = await latestDeliveryByContract(
          contracts.map((c) => c.id),
          { processingMaxDays: portalSettings.deliveriesProcessingMaxDays },
        );
        for (const c of contracts) {
          const row = latest.get(c.id);
          const transit = row
            ? latestInTransit([row], { maxDays: portalSettings.deliveriesInTransitMaxDays })
            : null;
          if (transit) inTransitLines.set(c.id, inTransitLineHtml({ locale, row: transit }));
        }
      } catch (err) {
        console.error("[portal] in-transit lines (home) failed", err);
      }
    }

    // Value-first cards (portalGrowth.homeValueCard, v1.20.0): the card
    // leads with captured member savings + milestone proximity instead of
    // one-tap skip/delay. Savings are money-true captured discounts — one
    // batched query for the whole page, contained (a value tile is never
    // worth failing the portal home for).
    let savingsByContract = new Map<string, number>();
    if (growth.homeValueCard) {
      try {
        savingsByContract = await memberSavingsCents(contracts.map((c) => c.id));
      } catch (err) {
        console.error("[portal] member savings scan failed", err);
      }
    }
    // THE next-order estimate per contract (P2.4): lines-free (money only —
    // the card lists the mirror's lines itself), live grant applied inside.
    // Charge timing once per page; preparing state from one attempts query.
    const timing = await resolveChargeTiming(shop.id, shop.ianaTimezone);
    // One attempts query answers both "preparing?" and the ORDER DATE being
    // prepared (the in-flight attempt's own date — the mirror pointer is
    // already the following cycle at that moment).
    const preparingDates = await preparingOrderDateByContract(contracts, timing);
    const preparingMap = new Map<string, boolean>();
    for (const [id, date] of preparingDates) preparingMap.set(id, date != null);
    const estimates = new Map<string, NextChargeEstimate>();
    for (const contract of contracts) {
      let grant: Awaited<ReturnType<typeof getActiveDiscountForCycle>> | undefined;
      try {
        grant = await getActiveDiscountForCycle(contract.id);
      } catch (err) {
        console.error("[portal] discount grant lookup failed", contract.id, err);
      }
      estimates.set(
        contract.id,
        await safeEstimateNextCharge(
          { id: shop.id, ianaTimezone: shop.ianaTimezone },
          contract,
          {
            includeScheduledGifts: false,
            ...(grant !== undefined ? { grant } : {}),
          },
        ),
      );
    }

    // Newer card on file (v1.28.0, P1.8): contracts the webhook TOLD about a
    // new method (dunning.new_method_detected, action notified, ≤30 days)
    // that still pay with another one. Rides the payment-methods list
    // switch (the button IS that list's verb); real customers only;
    // contained (empty map on failure).
    let newCardHits = new Map<string, NewCardBannerHit>();
    if (portalSettings.paymentMethodsList && !portalSession.isPreview) {
      newCardHits = await newCardBannerHits(contracts, {
        preExpiryNoticeDays: dunningSettings.preExpiryNoticeDays,
        tz: shop.ianaTimezone,
        // Liveness re-check through the detail page's 60 s memo (one Shopify
        // read per customer at most); null on failure keeps the hit.
        liveMethodIds: async (customerGid) => {
          try {
            const admin = await adminClientForShop(session.shop);
            const live = await listLivePaymentMethodsCached(admin, customerGid);
            return new Set(live.map((m) => m.id));
          } catch (err) {
            console.error("[portal] new-card banner method read failed", err);
            return null;
          }
        },
      });
    }

    // Cancel-intent banner (v1.28.0, P3.6): for cancelFlow.intentBannerDays
    // after a walked-away cancel session, the reason-matched options — the
    // same truth the follow-up email carries. Above the cards, outside the
    // growth helpers (this is cancel-flow context, not growth copy).
    // Contained: renders nothing on any failure.
    try {
      const cancelFlow = await getSetting(shop.id, "cancelFlow");
      if (cancelFlow.enabled && cancelFlow.intentBannerDays > 0) {
        let supportAvailable = false;
        try {
          supportAvailable = (await getSupportChannels(shop.id)).hasAny;
        } catch {
          supportAvailable = false;
        }
        body += await renderIntentBanner(contracts, {
          shopId: shop.id,
          tz: shop.ianaTimezone,
          locale,
          csrf: portalSession.csrfToken,
          preview: portalSession.previewToken,
          isPreview: portalSession.isPreview,
          bannerDays: cancelFlow.intentBannerDays,
          downsizeEnabled: cancelFlow.downsizeSaveEnabled,
          preparingByContract: preparingMap,
          supportAvailable,
        });
      }
    } catch (err) {
      console.error("[portal] cancel-intent banner failed", err);
    }

    for (const contract of contracts) {
      body += contractCardHtml({
        contract,
        locale,
        tz: shop.ianaTimezone,
        csrf: portalSession.csrfToken,
        preview: portalSession.previewToken,
        contextualPrompts: portalSettings.contextualPrompts,
        promptBufferDays: portalSettings.contextualPromptBufferDays,
        promptDelayWeeks: portalSettings.contextualPromptDelayWeeks,
        locked: lockStateFor(lockRules, contract, shop.ianaTimezone).locked,
        valueCard: growth.homeValueCard,
        savedCents: savingsByContract.get(contract.id) ?? 0,
        milestoneAway: milestoneRemaining(
          contract.ordersCount,
          lifecycle.milestoneGiftCycle,
          lifecycle.milestoneLadder,
        ),
        dunning: dunningByContract.get(contract.id) ?? null,
        payment: derivePortalPaymentState(contract, {
          preExpiryNoticeDays: dunningSettings.preExpiryNoticeDays,
          tz: shop.ianaTimezone,
        }),
        estimate: estimates.get(contract.id)!,
        cutoff: contractCutoff(contract.nextBillingDate, timing),
        preparing: preparingMap.get(contract.id) ?? false,
        preparingOrderDate: preparingDates.get(contract.id) ?? null,
        timelineLine: timelineLines.get(contract.id) ?? "",
        inTransitLine: inTransitLines.get(contract.id) ?? "",
        newCard: newCardHits.get(contract.id) ?? null,
        returnTo: homeReturnTo(requestUrl),
      });
    }

    // Impression event for every payment-issue card — real customers only,
    // once per case per window (shared with the detail banner).
    if (!portalSession.isPreview) {
      for (const contract of contracts) {
        const view = dunningByContract.get(contract.id);
        if (!view || contract.isDemo) continue;
        await logDunningBannerShown({
          shopId: shop.id,
          contract,
          view,
          surface: "home",
          windowHours: portalSettings.dunningBannerEventHours,
        });
      }
    }
  }

  return liquid(
    portalPage({
      locale,
      title: t(locale, "portal.index.title"),
      body,
      activeNav: "subscriptions",
      toast,
      isPreview: portalSession.isPreview,
      previewToken: portalSession.previewToken,
    }),
  );
};
