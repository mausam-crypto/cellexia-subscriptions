import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import type { CancelSession } from "@prisma/client";
import prisma from "~/db.server";
import { t } from "~/lib/i18n/i18n.server";
import { getSetting } from "~/lib/settings/settings.server";
import { clampGrantPercentForContract } from "~/lib/billing/stacking.server";
import { formatShopDate } from "~/lib/dates.server";
import {
  contractFrequency,
  formatFrequency,
  parseFrequencyToken,
  type Frequency,
} from "~/lib/frequency";
import { withLocale } from "~/lib/portal/layout.server";
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
  eligibleForFinalOffer,
  getActiveSession,
  getLatestSavedSession,
  getSavesForReason,
  hasSeenFinalOffer,
  recordFinalOfferShown,
  recordReason,
  recordSaveShown,
  startCancelSession,
  type AcceptSaveParams,
} from "~/lib/cancel/engine.server";
import {
  pageConfirm,
  pageDone,
  pageFinal,
  pageReason,
  pageSaved,
  pageSaves,
} from "~/lib/cancel/pages.server";
import {
  csrfOk,
  renderCancelPage,
  requireCancelContext,
  type CancelRouteContext,
} from "~/lib/cancel/portal.server";

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
      );
    case "final":
      return loadFinal(ctx, hasError);
    case "confirm":
      return loadConfirm(ctx, hasError);
    case "done":
      return loadDone(ctx);
    case "saved":
      return loadSaved(ctx);
  }
};

/** Active session, or a redirect (done when cancelled, step 1 otherwise). */
async function requireSessionOrRestart(
  ctx: CancelRouteContext,
): Promise<CancelSession | Response> {
  if (ctx.contract.status === "CANCELLED") return redirect(toPath(ctx, "done"));
  const session = await getActiveSession(ctx.contract.id);
  return session ?? redirect(toPath(ctx));
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
      finalOfferEligible: true,
      previewToken: ctx.portalSession.previewToken,
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
    finalOfferEligible,
    previewToken: ctx.portalSession.previewToken,
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

  await recordFinalOfferShown(session.id);
  const cancelFlow = await getSetting(shop.id, "cancelFlow");
  // Discount stacking cap: show the percent acceptFinalOffer will actually
  // grant (plan ongoing discount + grant <= maxTotalDiscountPct).
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

async function loadConfirm(ctx: CancelRouteContext, hasError: boolean) {
  if (ctx.contract.status === "CANCELLED") return redirect(toPath(ctx, "done"));

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

  return renderCancelPage(ctx, pageConfirm({
    locale: ctx.locale,
    csrf: ctx.portalSession.csrfToken,
    contractId: ctx.contract.id,
    showError: hasError,
    finalOfferEligible,
    previewToken: ctx.portalSession.previewToken,
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
    case "SKIP":
      messageKey = "cancel.saved.skip";
      messageVars = { date: fmt(contract.nextBillingDate) };
      break;
    case "FREQUENCY":
      messageKey = "cancel.saved.frequency";
      // The accepted cadence is read back off the contract itself:
      // contractFrequency uses the exact unit/count mirror when present, else
      // the legacy intervalWeeks as a WEEK cadence.
      messageVars = {
        frequency: formatFrequency(
          (key, vars) => t(locale, key, vars),
          "every",
          contractFrequency(contract),
        ),
        date: fmt(contract.nextBillingDate),
      };
      break;
    case "PAUSE":
      messageKey = "cancel.saved.pause";
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
    case "EDUCATION":
      messageKey = "cancel.saved.education";
      showEducationLinks = true;
      break;
    case "SUPPORT":
      messageKey = "cancel.saved.support";
      showSupportLink = true;
      break;
  }

  return renderCancelPage(ctx, pageSaved({
    locale,
    contractId: contract.id,
    messageKey,
    messageVars,
    showEducationLinks,
    showSupportLink,
    previewToken: ctx.portalSession.previewToken,
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
      // Terminal pages take no POSTs.
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

  const cleanParams: AcceptSaveParams = {
    frequency: optionalFrequency(form.get("frequency")),
    weeks: parsePositiveInt(form.get("weeks")),
    months: parsePositiveInt(form.get("months")),
    lineId: optionalString(form.get("lineId")),
    variantId: optionalString(form.get("variantId")),
  };

  try {
    await acceptSave(session.id, kind, cleanParams);
    return redirect(toPath(ctx, "saved"));
  } catch (err) {
    console.error("[cancel] save accept failed", contract.id, kind, err);
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

  const session =
    (await getActiveSession(contract.id)) ??
    (await startCancelSession(contract.id, "PORTAL"));

  try {
    await completeCancel(session.id, "customer");
    return redirect(toPath(ctx, "done"));
  } catch (err) {
    console.error("[cancel] completeCancel failed", contract.id, err);
    return redirect(toPath(ctx, "confirm", true));
  }
}
