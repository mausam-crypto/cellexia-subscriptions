import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import type { CancelSession } from "@prisma/client";
import prisma from "~/db.server";
import { t } from "~/lib/i18n/i18n.server";
import { getSetting } from "~/lib/settings/settings.server";
import { clampGrantPercentForContract } from "~/lib/billing/stacking.server";
import { formatShopDate } from "~/lib/dates.server";
import { formatMoney } from "~/lib/money";
import {
  contractFrequency,
  formatFrequency,
  parseFrequencyToken,
  type Frequency,
} from "~/lib/frequency";
import { escapeHtml, portalPage, withLocale } from "~/lib/portal/layout.server";
import { PORTAL_BASE_PATH } from "~/lib/portal/session.server";
import {
  FINAL_DISCOUNT,
  REASONS,
  SAVE_KINDS,
  cancelPublicPath,
  copyVariantFor,
  isCancelStep,
  reasonConfig,
  type CancelReason,
  type CancelStep,
  type SaveKind,
} from "~/lib/cancel/config.server";
import {
  acceptFinalOffer,
  acceptSave,
  completeCancel,
  conciergeHoldPlan,
  conciergeTopicForReason,
  eligibleForFinalOffer,
  getActiveSession,
  getLatestSavedSession,
  getSavesForReason,
  hasSeenFinalOffer,
  recordFinalOfferShown,
  recordReason,
  recordSaveShown,
  scheduleCancel,
  startCancelSession,
  type AcceptSaveParams,
  type SaveOffer,
} from "~/lib/cancel/engine.server";
import {
  pageConfirm,
  pageDone,
  pageFinal,
  pageReason,
  pageSaved,
  pageSaves,
  pageScheduled,
  type ConciergeCardInfo,
} from "~/lib/cancel/pages.server";
import {
  csrfOk,
  renderCancelPage,
  requireCancelContext,
  type CancelRouteContext,
} from "~/lib/cancel/portal.server";
import {
  buildRetentionSummary,
  type RetentionSummary,
} from "~/lib/cancel/summary.server";
import {
  DEFAULT_REPLY_PROMISE,
  getSupportChannels,
  type ReplyPromise,
} from "~/lib/support/channels.server";
import { readReplyPromise, supportReplyPromise } from "~/lib/support/reply-promise.server";
import { resumeReminderPromised } from "~/lib/notifications/promise.server";
import { getEducationLinks } from "~/lib/portal/education.server";
import { educationTimelineTextFor } from "~/lib/portal/timeline.server";
import {
  isSupportTopic,
  normalizeSupportMessage,
  supportBudgetExceeded,
} from "~/lib/support/request.server";

/**
 * Cancel flow — steps 2..5, served through the app proxy at
 * /apps/cellexia-subs/cancel/:id/:step. Resource route (liquid HTML, no React).
 *
 * Steps: reason → saves → final → confirm → done (+ saved confirmation).
 *
 * Psychology: offers are reason-gated — nothing is shown before the survey is
 * answered, and each reason unlocks only the saves that address it (see
 * config.server.ts). At most settings.cancelFlow.maxSavesShown concrete
 * one-tap cards; the deeper final offer is reserved for the very last moment
 * and is honestly one-time (cooldown + show-once enforced in
 * eligibleForFinalOffer). Never showing generic discounts before knowing the
 * reason prevents discount training.
 *
 * Compliance (FTC click-to-cancel / EU-UK fairness): skipping every offer,
 * cancellation completes in ≤3 required clicks — "Continue to cancel"
 * (step 1) → reason submit (step 2, with a visible "I'd rather not say"
 * bypass) → "No thanks, cancel my subscription" (step 3), which POSTs the
 * confirm action and completes IMMEDIATELY — no interstitial is ever
 * auto-inserted. The deeper final offer is strictly OPT-IN: it only renders
 * when the customer taps "See my final offer" (saves/confirm pages), is
 * eligible at most once per cooldown, and its decline cancels immediately —
 * never a loop, never a hidden link. Confirm/done state exactly what happens
 * next (no more charges, restart anytime).
 */

function toPath(
  ctx: CancelRouteContext,
  step?: string,
  error = false,
): string {
  return withLocale(
    `${cancelPublicPath(ctx.contract.id, step)}${error ? "?error=1" : ""}`,
    ctx.locale,
    ctx.portalSession.previewToken,
  );
}

/** Append a query param to a path that may already carry ?locale=. */
function withParam(path: string, name: string, value: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}${name}=${encodeURIComponent(value)}`;
}

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const ctx = await requireCancelContext(request, params.id);
  const step = params.step;
  if (!isCancelStep(step)) return redirect(toPath(ctx));

  const hasError = new URL(request.url).searchParams.has("error");

  switch (step) {
    case "reason":
      return loadReason(ctx, hasError);
    case "saves":
      return loadSaves(
        ctx,
        hasError,
        new URL(request.url).searchParams.get("r"),
        new URL(request.url).searchParams.get("error"),
      );
    case "final":
      return loadFinal(ctx, hasError);
    case "confirm":
      return loadConfirm(ctx, hasError);
    case "done":
      return loadDone(ctx);
    case "saved":
      return loadSaved(ctx);
    case "scheduled":
      return loadScheduled(ctx);
  }
};

/** Active session, or a redirect (done when cancelled, step 1 otherwise). */
async function requireSessionOrRestart(
  ctx: CancelRouteContext,
): Promise<CancelSession | Response> {
  if (ctx.contract.status === "CANCELLED") return redirect(toPath(ctx, "done"));
  // A scheduled cancel stands (P3.8): the only honest page is "scheduled".
  if (ctx.contract.cancelScheduledAt) return redirect(toPath(ctx, "scheduled"));
  const session = await getActiveSession(ctx.contract.id);
  return session ?? redirect(toPath(ctx));
}

/**
 * Concierge (SUPPORT) card inputs (v1.28.0, P3.7): topic matched to the
 * reason, the survey free text as the draft, the reply promise from the
 * support settings, and the hold day ONLY when conciergeHoldPlan says the
 * hold applies right now (the accept path applies the same rule). Contained:
 * a failed read renders Stage C's plain form.
 */
async function conciergeInfoFor(
  ctx: CancelRouteContext,
  offers: SaveOffer[],
  reason: string | null,
  reasonDetail: string | null,
): Promise<ConciergeCardInfo | null> {
  if (!offers.some((o) => o.kind === "SUPPORT")) return null;
  try {
    const [channels, hold] = await Promise.all([
      getSupportChannels(ctx.shop.id),
      conciergeHoldPlan(ctx.shop.id, ctx.contract, ctx.shop.ianaTimezone),
    ]);
    return {
      topic: conciergeTopicForReason(reason),
      prefill: reasonDetail ?? "",
      replyWithin: channels.replyWithin,
      holdUntil: hold.applies ? hold.newNextDate : null,
      holdDays: hold.days,
    };
  } catch (err) {
    console.error("[cancel] concierge card info failed", ctx.contract.id, err);
    return null;
  }
}

async function loadReason(ctx: CancelRouteContext, hasError: boolean) {
  let selectedReason: CancelReason | null = null;
  let detail: string | null = null;

  if (ctx.portalSession.isPreview) {
    // Preview: no CancelSession exists (nothing records) — blank survey.
    if (ctx.contract.status === "CANCELLED") return redirect(toPath(ctx, "done"));
  } else {
    const session = await requireSessionOrRestart(ctx);
    if (session instanceof Response) return session;
    selectedReason = reasonConfig(session.reason)?.key ?? null;
    detail = session.reasonDetail;
  }

  return renderCancelPage(ctx, pageReason({
    locale: ctx.locale,
    csrf: ctx.portalSession.csrfToken,
    contractId: ctx.contract.id,
    selectedReason,
    detail,
    showError: hasError,
    previewToken: ctx.portalSession.previewToken,
  }));
}

async function loadSaves(
  ctx: CancelRouteContext,
  hasError: boolean,
  previewReason?: string | null,
  errorKind?: string | null,
) {
  const { shop, contract, locale } = ctx;

  if (ctx.portalSession.isPreview) {
    // Preview: reason arrives as ?r= (nothing was recorded); default to the
    // most save-able reason so representative offers always show. Read-only —
    // no recordSaveShown; the final-offer opt-in link always shows so the
    // admin can walk the whole flow.
    if (contract.status === "CANCELLED") return redirect(toPath(ctx, "done"));
    const reason = reasonConfig(previewReason) ?? REASONS[0];
    const offers = await getSavesForReason(shop.id, reason.key, contract);
    if (offers.length === 0) return redirect(toPath(ctx, "final"));
    return renderCancelPage(ctx, pageSaves({
      locale,
      csrf: ctx.portalSession.csrfToken,
      contractId: contract.id,
      offers,
      tz: shop.ianaTimezone,
      currencyCode: contract.currencyCode,
      showError: hasError,
      errorKind,
      finalOfferEligible: true,
      previewToken: ctx.portalSession.previewToken,
      support: await getSupportChannels(shop.id),
      education: await getEducationLinks(shop.id),
      resumeReminder: await resumeReminderPromised(shop.id),
      educationTimelineText: offers.some((o) => o.kind === "EDUCATION")
        ? await educationTimelineTextFor({
            shopId: shop.id,
            tz: shop.ianaTimezone,
            locale,
            contract,
            isPreview: true,
          })
        : null,
      concierge: await conciergeInfoFor(ctx, offers, reason.key, null),
    }));
  }

  const session = await requireSessionOrRestart(ctx);
  if (session instanceof Response) return session;

  const reason = reasonConfig(session.reason);
  if (!reason) return redirect(toPath(ctx, "reason"));

  const offers = await getSavesForReason(shop.id, reason.key, contract);
  if (offers.length === 0) {
    // Nothing applicable to offer — go straight to the exit. The confirm page
    // carries the opt-in final-offer link; nothing is auto-interjected.
    return redirect(toPath(ctx, "confirm"));
  }

  await recordSaveShown(session.id, offers);

  const finalOfferEligible =
    !hasSeenFinalOffer(session) &&
    (await eligibleForFinalOffer(contract.id, {
      excludeSessionId: session.id,
    }));

  return renderCancelPage(ctx, pageSaves({
    locale,
    csrf: ctx.portalSession.csrfToken,
    contractId: contract.id,
    offers,
    tz: shop.ianaTimezone,
    currencyCode: contract.currencyCode,
    showError: hasError,
    errorKind,
    finalOfferEligible,
    previewToken: ctx.portalSession.previewToken,
    support: await getSupportChannels(shop.id),
    education: await getEducationLinks(shop.id),
    resumeReminder: await resumeReminderPromised(shop.id),
    // Results-timeline reuse (P4.1): the EDUCATION card speaks to the
    // customer's own routine week (holdout arm / timeline off ⇒ static copy).
    educationTimelineText: offers.some((o) => o.kind === "EDUCATION")
      ? await educationTimelineTextFor({
          shopId: shop.id,
          tz: shop.ianaTimezone,
          locale,
          contract,
          isPreview: ctx.portalSession.isPreview,
        })
      : null,
    // Concierge save (P3.7): reason-matched topic, the survey text as draft,
    // the reply promise and the hold day (only when it will apply).
    concierge: await conciergeInfoFor(ctx, offers, session.reason, session.reasonDetail),
  }));
}

async function loadFinal(ctx: CancelRouteContext, hasError: boolean) {
  const { shop, contract, locale } = ctx;

  if (ctx.portalSession.isPreview) {
    // Preview: always show the final offer (the admin came to see it) and
    // record nothing — no session, no shown-marker, no cooldown consumed.
    if (contract.status === "CANCELLED") return redirect(toPath(ctx, "done"));
    const cancelFlow = await getSetting(shop.id, "cancelFlow");
    const clamp = await clampGrantPercentForContract(
      shop.id,
      contract.lines,
      cancelFlow.finalOfferPct,
    );
    return renderCancelPage(ctx, pageFinal({
      locale,
      csrf: ctx.portalSession.csrfToken,
      contractId: contract.id,
      percent: clamp.percent,
      cycles: cancelFlow.finalOfferCycles,
      copyVariant: copyVariantFor(contract.id),
      showError: hasError,
      previewToken: ctx.portalSession.previewToken,
    }));
  }

  const session = await requireSessionOrRestart(ctx);
  if (session instanceof Response) return session;

  if (
    !(await eligibleForFinalOffer(contract.id, {
      excludeSessionId: session.id,
    }))
  ) {
    return redirect(toPath(ctx, "confirm"));
  }

  // The engine resolves the presented depth (experiment overlay + stacking
  // clamp) and records it into savesShown — render EXACTLY what it recorded,
  // so shown, refreshed and granted percents can never diverge.
  const shownOffer = await recordFinalOfferShown(session.id);

  return renderCancelPage(ctx, pageFinal({
    locale,
    csrf: ctx.portalSession.csrfToken,
    contractId: contract.id,
    percent: shownOffer.percent,
    cycles: shownOffer.cycles,
    copyVariant: copyVariantFor(contract.id),
    showError: hasError,
    previewToken: ctx.portalSession.previewToken,
  }));
}

async function loadConfirm(ctx: CancelRouteContext, hasError: boolean) {
  if (ctx.contract.status === "CANCELLED") return redirect(toPath(ctx, "done"));
  if (ctx.contract.cancelScheduledAt) return redirect(toPath(ctx, "scheduled"));

  // The final offer is opt-in only: offer the link when eligible and not
  // already seen this session (never auto-redirect into it).
  let finalOfferEligible = false;
  if (ctx.portalSession.isPreview) {
    finalOfferEligible = true; // admins walking the flow always see the link
  } else {
    const session = await getActiveSession(ctx.contract.id);
    finalOfferEligible =
      session != null &&
      !hasSeenFinalOffer(session) &&
      (await eligibleForFinalOffer(ctx.contract.id, {
        excludeSessionId: session.id,
      }));
  }

  // Money-true ledger of what cancelling forfeits (v1.28.0). Contained: a
  // failed read renders the generic points — the confirm page (and its
  // cancel button) must never depend on it.
  let summary: RetentionSummary | null = null;
  try {
    summary = await buildRetentionSummary(ctx.shop, ctx.contract);
  } catch (err) {
    console.error("[cancel] confirm: retention summary failed", ctx.contract.id, err);
  }

  return renderCancelPage(ctx, pageConfirm({
    locale: ctx.locale,
    csrf: ctx.portalSession.csrfToken,
    contractId: ctx.contract.id,
    showError: hasError,
    finalOfferEligible,
    summary,
    previewToken: ctx.portalSession.previewToken,
    // Plan lock window (P3.8): the CTA schedules the cancellation for the
    // unlock day — never a hidden "cancel today" the lock would refuse.
    scheduled:
      ctx.lock.locked && ctx.lock.until
        ? { date: ctx.lock.until, tz: ctx.shop.ianaTimezone }
        : null,
    // Prepaid (P3.8): only app-controlled facts (no new charge); nothing is
    // claimed about deliveries already paid for (Shopify-side fulfilment).
    prepaid: ctx.contract.isPrepaid === true,
  }));
}

async function loadDone(ctx: CancelRouteContext) {
  if (ctx.contract.status !== "CANCELLED") return redirect(toPath(ctx));
  return renderCancelPage(ctx, pageDone({
    locale: ctx.locale,
    contractId: ctx.contract.id,
    csrf: ctx.portalSession.csrfToken,
    previewToken: ctx.portalSession.previewToken,
  }));
}

/** Scheduled-cancel page (P3.8): "cancels on {date} · keep", or "kept". */
async function loadScheduled(ctx: CancelRouteContext) {
  if (ctx.contract.status === "CANCELLED") return redirect(toPath(ctx, "done"));
  return renderCancelPage(ctx, pageScheduled({
    locale: ctx.locale,
    csrf: ctx.portalSession.csrfToken,
    contractId: ctx.contract.id,
    tz: ctx.shop.ianaTimezone,
    scheduledAt: ctx.contract.cancelScheduledAt ?? null,
    // The lock lifted since scheduling (lockDays lowered / plan changed):
    // an immediate cancel is honest now — offer it (P3.8; the index route's
    // cancel_now intent executes it under the same guard).
    canCancelNow: !ctx.lock.locked && !ctx.portalSession.isPreview,
    previewToken: ctx.portalSession.previewToken,
  }));
}

async function loadSaved(ctx: CancelRouteContext) {
  const { shop, contract, locale } = ctx;
  const saved = await getLatestSavedSession(contract.id);
  if (!saved?.saveAccepted) return redirect(toPath(ctx));

  const tz = shop.ianaTimezone;
  const fmt = (d: Date | null): string =>
    d ? formatShopDate(d, tz, locale) : t(locale, "cancel.common.soon");

  let messageKey = "cancel.saved.title";
  let messageVars: Record<string, string | number> = {};
  let showEducationLinks = false;
  let showSupportLink = false;

  switch (saved.saveAccepted) {
    case "SKIP": {
      // Per-line variant (P2.5): the accepted save left ONE product out of
      // the next order — the mirror flag on that line is the witness (the
      // whole-order skip clears every per-line flag, so a flag here means
      // the per-line save was the one accepted).
      const skippedLine = contract.lines.find(
        (l) => !l.isGift && !l.isOneTimeAddon && l.skippedCycleIndex != null,
      );
      if (skippedLine) {
        messageKey = "cancel.saved.skip_line";
        messageVars = {
          title: skippedLine.title,
          date: fmt(contract.nextBillingDate),
        };
      } else {
        messageKey = "cancel.saved.skip";
        messageVars = { date: fmt(contract.nextBillingDate) };
      }
      break;
    }
    case "FREQUENCY":
      // The accepted cadence is read back off the contract itself:
      // contractFrequency uses the exact unit/count mirror when present, else
      // the legacy intervalWeeks as a WEEK cadence. A PAUSED contract (the
      // "resume later, slower" save, v1.28.0) resumes on its resume day —
      // its nextBillingDate is not the next order.
      messageKey =
        contract.status === "PAUSED" && contract.resumeAt
          ? "cancel.saved.frequency_paused"
          : "cancel.saved.frequency";
      messageVars = {
        frequency: formatFrequency(
          (key, vars) => t(locale, key, vars),
          "every",
          contractFrequency(contract),
        ),
        date: fmt(contract.nextBillingDate),
        resumeDate: fmt(contract.resumeAt),
      };
      break;
    case "PAUSE":
      // "We'll remind you first" only when the reminder will actually go out
      // (review fix): merchant switches can silence it.
      messageKey = (await resumeReminderPromised(shop.id))
        ? "cancel.saved.pause"
        : "cancel.saved.pause_noremind";
      messageVars = { resumeDate: fmt(contract.resumeAt) };
      break;
    case "EXTEND_PAUSE":
      messageKey = (await resumeReminderPromised(shop.id))
        ? "cancel.saved.extend_pause"
        : "cancel.saved.extend_pause_noremind";
      messageVars = { resumeDate: fmt(contract.resumeAt) };
      break;
    case "DISCOUNT": {
      const grant = await prisma.discountGrant.findFirst({
        where: { contractId: contract.id, type: "SAVE_OFFER" },
        orderBy: { createdAt: "desc" },
      });
      const cancelFlow = await getSetting(shop.id, "cancelFlow");
      messageKey = "cancel.saved.discount";
      messageVars = {
        percent: grant?.percent ?? cancelFlow.reasonOfferPctDefault,
        cycles: grant?.cyclesTotal ?? cancelFlow.reasonOfferCyclesDefault,
      };
      break;
    }
    case FINAL_DISCOUNT: {
      const grant = await prisma.discountGrant.findFirst({
        where: { contractId: contract.id, type: "SAVE_OFFER_FINAL" },
        orderBy: { createdAt: "desc" },
      });
      const cancelFlow = await getSetting(shop.id, "cancelFlow");
      messageKey = "cancel.saved.final_discount";
      messageVars = {
        percent: grant?.percent ?? cancelFlow.finalOfferPct,
        cycles: grant?.cyclesTotal ?? cancelFlow.finalOfferCycles,
      };
      break;
    }
    case "SWAP": {
      const swapped = contract.lines.find((l) => l.addedVia === "SWAP");
      messageKey = "cancel.saved.swap";
      messageVars = { title: swapped?.title ?? contract.lines[0]?.title ?? "" };
      break;
    }
    case "DOWNSIZE": {
      // The new per-order figure is read back off the contract itself (the
      // recurring subtotal after the quantity/variant change) — the same
      // base the card's totals were computed on.
      const total = contract.lines
        .filter((l) => !l.isGift && !l.isOneTimeAddon)
        .reduce((sum, l) => sum + l.currentPriceCents * l.quantity, 0);
      // A smaller size / different product DID change what arrives — say
      // which (the swapped line carries addedVia SWAP); only the fewer-units
      // mode can truthfully claim nothing else changed.
      const swappedLine = contract.lines.find((l) => l.addedVia === "SWAP");
      let mode: string | null = null;
      try {
        const ev = await prisma.subscriberEvent.findFirst({
          where: { contractId: contract.id, type: "cancel.save_accepted" },
          orderBy: { createdAt: "desc" },
          select: { payload: true },
        });
        const p = ev?.payload as { downsizeMode?: unknown } | null;
        mode = typeof p?.downsizeMode === "string" ? p.downsizeMode : null;
      } catch (err) {
        console.error("[cancel] saved page: downsize mode read failed", contract.id, err);
      }
      const productChanged =
        mode === "VARIANT" || mode === "PRODUCT" || (mode == null && !!swappedLine);
      messageKey = productChanged
        ? "cancel.saved.downsize_swapped"
        : "cancel.saved.downsize";
      messageVars = {
        total: formatMoney(total, contract.currencyCode, locale),
        ...(productChanged
          ? { title: swappedLine?.title ?? contract.lines[0]?.title ?? "" }
          : {}),
      };
      break;
    }
    case "GIFT": {
      // The granted variant title lives on the newest SAVE_FLOW grant's
      // scheduling event payload; the session's savesShown offer is the
      // simpler read and always present (accept requires it).
      const shownGift = (
        Array.isArray(saved.savesShown) ? saved.savesShown : []
      ).find(
        (s): s is { kind: string; title: string } =>
          typeof s === "object" &&
          s != null &&
          (s as { kind?: unknown }).kind === "GIFT",
      );
      messageKey = "cancel.saved.gift";
      messageVars = { giftTitle: shownGift?.title ?? "" };
      break;
    }
    case "EDUCATION":
      messageKey = "cancel.saved.education";
      showEducationLinks = true;
      break;
    case "SUPPORT": {
      // Concierge save (P3.7): the honest state is PENDING — the request is
      // in, a human answers within the promised time (the promise the accept
      // event recorded, else the current setting — supportReplyPromise phrases
      // it), and when the hold applied the next order's new day is stated
      // (read back off the contract; the accept event says whether the hold
      // happened).
      showSupportLink = true;
      let holdApplied = false;
      let promise: ReplyPromise = DEFAULT_REPLY_PROMISE;
      try {
        const [ev, channels] = await Promise.all([
          prisma.subscriberEvent.findFirst({
            where: { contractId: contract.id, type: "cancel.save_accepted" },
            orderBy: { createdAt: "desc" },
            select: { payload: true },
          }),
          getSupportChannels(shop.id),
        ]);
        const p = ev?.payload as { holdApplied?: unknown; replyWithin?: unknown } | null;
        holdApplied = p?.holdApplied === true;
        promise = readReplyPromise(p?.replyWithin) ?? channels.replyWithin;
      } catch (err) {
        console.error("[cancel] saved page: concierge read failed", contract.id, err);
      }
      const promiseText = supportReplyPromise(locale, promise);
      if (holdApplied && contract.nextBillingDate) {
        messageKey = "cancel.saved.support_hold";
        messageVars = { promise: promiseText, date: fmt(contract.nextBillingDate) };
      } else {
        messageKey = "cancel.saved.support_pending";
        messageVars = { promise: promiseText };
      }
      break;
    }
  }

  return renderCancelPage(ctx, pageSaved({
    locale,
    contractId: contract.id,
    messageKey,
    messageVars,
    showEducationLinks,
    showSupportLink,
    previewToken: ctx.portalSession.previewToken,
    support:
      showEducationLinks || showSupportLink
        ? await getSupportChannels(ctx.shop.id)
        : undefined,
    education: showEducationLinks ? await getEducationLinks(ctx.shop.id) : undefined,
  }));
}

// ── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const ctx = await requireCancelContext(request, params.id);
  const step = params.step;
  if (!isCancelStep(step)) return redirect(toPath(ctx));

  const form = await request.formData();
  if (!csrfOk(ctx, form)) return redirect(toPath(ctx, step, true));

  if (ctx.portalSession.isPreview) return previewAction(ctx, step, form);

  switch (step) {
    case "reason":
      return actionReason(ctx, form);
    case "saves":
      return actionSaves(ctx, form);
    case "final":
      return actionFinal(ctx, form);
    case "confirm":
      return actionConfirm(ctx);
    case "done":
    case "saved":
    case "scheduled":
      // Terminal pages take no POSTs (the scheduled page's keep button posts
      // to /cancel/:id — the step-1 route).
      return redirect(toPath(ctx, step));
  }
};

/**
 * Preview sessions walk the whole flow but nothing records and nothing
 * cancels: navigation POSTs advance to the next step as if they succeeded,
 * while every action that would execute (accept a save, accept the final
 * offer, complete the cancel) bounces back with the preview toast. A preview
 * session can therefore never cancel a real contract.
 */
function previewAction(ctx: CancelRouteContext, step: CancelStep, form: FormData) {
  switch (step) {
    case "reason": {
      const reason = reasonConfig(String(form.get("reason") ?? ""));
      if (!reason) return redirect(toPath(ctx, "reason", true));
      // Carry the chosen reason so the saves page previews matching offers.
      return redirect(withParam(toPath(ctx, "saves"), "r", reason.key));
    }
    case "saves":
      return redirect(
        withParam(toPath(ctx, "saves"), "toast", "preview_blocked"),
      );
    case "final":
      if (String(form.get("intent") ?? "") !== "accept_final") {
        return redirect(toPath(ctx, "final"));
      }
      return redirect(
        withParam(toPath(ctx, "final"), "toast", "preview_blocked"),
      );
    case "confirm":
      return redirect(
        withParam(toPath(ctx, "confirm"), "toast", "preview_blocked"),
      );
    case "done":
    case "saved":
    case "scheduled":
      return redirect(toPath(ctx, step));
  }
}

async function actionReason(ctx: CancelRouteContext, form: FormData) {
  const { contract } = ctx;
  if (contract.status === "CANCELLED") return redirect(toPath(ctx, "done"));

  const reason = reasonConfig(String(form.get("reason") ?? ""));
  if (!reason) return redirect(toPath(ctx, "reason", true));

  const session =
    (await getActiveSession(contract.id)) ??
    (await startCancelSession(contract.id, "PORTAL"));

  const detailRaw = form.get("detail");
  await recordReason(
    session.id,
    reason.key,
    typeof detailRaw === "string" ? detailRaw : null,
  );
  return redirect(toPath(ctx, "saves"));
}

function parsePositiveInt(value: FormDataEntryValue | null): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function optionalString(value: FormDataEntryValue | null): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** v1.8.0 save cards post a "frequency" token; malformed tokens are dropped
 *  (the engine then falls back to the legacy weeks int, if posted). */
function optionalFrequency(
  value: FormDataEntryValue | null,
): Frequency | undefined {
  return typeof value === "string" && value.length > 0
    ? (parseFrequencyToken(value) ?? undefined)
    : undefined;
}

async function actionSaves(ctx: CancelRouteContext, form: FormData) {
  const { contract } = ctx;
  const session = await requireSessionOrRestart(ctx);
  if (session instanceof Response) return session;

  const kindRaw = String(form.get("kind") ?? "");
  if (!(SAVE_KINDS as readonly string[]).includes(kindRaw)) {
    return redirect(toPath(ctx, "saves", true));
  }
  const kind = kindRaw as SaveKind;

  // SUPPORT / EDUCATION (v1.28.0): the inline Get-help form's fields ride
  // along; acceptSave refuses these kinds without a message (the save IS
  // the submitted request — see AcceptSaveParams.support).
  const supportTopicRaw = String(form.get("support_topic") ?? "");
  const supportMessage = normalizeSupportMessage(form.get("support_message"));
  const cleanParams: AcceptSaveParams = {
    frequency: optionalFrequency(form.get("frequency")),
    weeks: parsePositiveInt(form.get("weeks")),
    months: parsePositiveInt(form.get("months")),
    lineId: optionalString(form.get("lineId")),
    variantId: optionalString(form.get("variantId")),
    quantity: parsePositiveInt(form.get("quantity")),
    ...(supportMessage
      ? {
          support: {
            topic: isSupportTopic(supportTopicRaw) ? supportTopicRaw : "OTHER",
            message: supportMessage,
          },
        }
      : {}),
  };

  // Support-bearing saves share the portal's per-customer support budget
  // (portal.mutationsPerHour + support.requestsPerHour, insert-then-count on
  // the same attempt rows POST /api/support uses): the SUPPORT/EDUCATION
  // card is a second door to submitSupportRequest, and a looped
  // reason→saves→submit would otherwise send the merchant an unbounded
  // stream of emails and Klaviyo events. Checked BEFORE the save is
  // claimed, so nothing is recorded when the budget is exhausted.
  if ((kind === "SUPPORT" || kind === "EDUCATION") && cleanParams.support) {
    if (
      await supportBudgetExceeded({
        shopId: ctx.shop.id,
        customerId: ctx.portalSession.customerId,
        email: ctx.portalSession.email,
        recordAttempt: true,
      })
    ) {
      return ctx.liquid(
        portalPage({
          locale: ctx.locale,
          title: t(ctx.locale, "portal.rate_limited.title"),
          body: `<div class="cxs-card"><p style="margin:0 0 8px">${escapeHtml(t(ctx.locale, "portal.rate_limited.body"))}</p><a class="cxs-btn cxs-btn--quiet cxs-btn--small" href="${withLocale(`${PORTAL_BASE_PATH}/`, ctx.locale, ctx.portalSession.previewToken)}">${escapeHtml(t(ctx.locale, "portal.rate_limited.back"))}</a></div>`,
          activeNav: "subscriptions",
          previewToken: ctx.portalSession.previewToken,
        }),
        { status: 429 },
      );
    }
  }

  try {
    await acceptSave(session.id, kind, cleanParams);
    return redirect(toPath(ctx, "saved"));
  } catch (err) {
    console.error("[cancel] save accept failed", contract.id, kind, err);
    // Shopify refused a contract-level save (FREQUENCY / DOWNSIZE / SWAP)
    // while one-off changes are staged on the next order: say so.
    if (err instanceof Error && err.name === "ContractEditBlockedError") {
      return redirect(withParam(toPath(ctx, "saves"), "error", "cycle_edits"));
    }
    return redirect(toPath(ctx, "saves", true));
  }
}

async function actionFinal(ctx: CancelRouteContext, form: FormData) {
  const { contract } = ctx;
  const session = await requireSessionOrRestart(ctx);
  if (session instanceof Response) return session;

  if (String(form.get("intent") ?? "") !== "accept_final") {
    return redirect(toPath(ctx, "final"));
  }
  try {
    await acceptFinalOffer(session.id);
    return redirect(toPath(ctx, "saved"));
  } catch (err) {
    console.error("[cancel] final offer accept failed", contract.id, err);
    return redirect(toPath(ctx, "final", true));
  }
}

/**
 * The terminal action: completes the cancellation IMMEDIATELY, always. No
 * interstitial is ever auto-inserted between the customer's decline/confirm
 * click and completion (FTC click-to-cancel — the final offer is reachable
 * only through the explicit opt-in link on the saves/confirm pages). A
 * missing session never blocks cancellation: one is created on the spot.
 */
async function actionConfirm(ctx: CancelRouteContext) {
  const { contract } = ctx;
  if (contract.status === "CANCELLED") return redirect(toPath(ctx, "done"));

  if (contract.cancelScheduledAt) return redirect(toPath(ctx, "scheduled"));

  const session =
    (await getActiveSession(contract.id)) ??
    (await startCancelSession(contract.id, "PORTAL"));

  // Plan lock window (P3.8): the confirm CTA read "schedule my cancellation
  // for {date}" — write cancelScheduledAt (the hourly job completes it);
  // never a cancel today the lock refuses, never a silent keep.
  if (ctx.lock.locked) {
    try {
      await scheduleCancel(session.id, "customer");
      return redirect(toPath(ctx, "scheduled"));
    } catch (err) {
      console.error("[cancel] scheduleCancel failed", contract.id, err);
      return redirect(toPath(ctx, "confirm", true));
    }
  }

  try {
    await completeCancel(session.id, "customer");
    return redirect(toPath(ctx, "done"));
  } catch (err) {
    console.error("[cancel] completeCancel failed", contract.id, err);
    return redirect(toPath(ctx, "confirm", true));
  }
}
