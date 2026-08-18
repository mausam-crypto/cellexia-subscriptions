import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { getSetting } from "~/lib/settings/settings.server";
import { withLocale } from "~/lib/portal/layout.server";
import {
  PAUSE_SUGGEST_MONTHS,
  cancelPublicPath,
  copyVariantFor,
} from "~/lib/cancel/config.server";
import {
  acceptSave,
  completeCancel,
  getActiveSession,
  keepScheduledCancel,
  startCancelSession,
} from "~/lib/cancel/engine.server";
import { buildRetentionSummary } from "~/lib/cancel/summary.server";
import { pauseExtendChoices } from "~/lib/portal/flex.server";
import { pageIntro } from "~/lib/cancel/pages.server";
import {
  csrfOk,
  renderCancelPage,
  requireCancelContext,
} from "~/lib/cancel/portal.server";

/**
 * Cancel flow — step 1 ("before you go"), served through the app proxy at
 * /apps/cellexia-subs/cancel/:id (:id = local contract cuid). Resource route: the
 * loader returns theme-wrapped liquid HTML, no React component.
 *
 * Psychology: the page leads with loss aversion — the concrete yearly saving,
 * tenure, milestone-gift progress and rewards at risk, all computed from real
 * data — and offers a one-tap 2-month pause as the default alternative
 * (a paused subscriber keeps the relationship; a cancelled one must be won
 * back). No discounts appear here: offers stay reason-gated behind step 2 so
 * customers are never trained to cancel for money off.
 *
 * Compliance (FTC click-to-cancel): "Continue to cancel" is a full-size
 * button with equal visual weight to the pause CTA, and skipping every offer
 * the whole flow completes in ≤3 required clicks (continue → reason submit —
 * itself skippable via "I'd rather not say" — → "No thanks, cancel my
 * subscription", which completes immediately; the deeper final offer is
 * opt-in only). When settings.cancelFlow.enabled is false, this page
 * redirects straight to the offer-free confirm step.
 */

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const ctx = await requireCancelContext(request, params.id);
  const { shop, contract, locale } = ctx;
  const to = (step?: string) =>
    withLocale(
      cancelPublicPath(contract.id, step),
      locale,
      ctx.portalSession.previewToken,
    );

  if (contract.status === "CANCELLED") return redirect(to("done"));
  // A scheduled cancellation already stands (v1.28.0, P3.8): the honest page
  // is "cancels on {date} · keep my subscription", not a second flow.
  if (contract.cancelScheduledAt) return redirect(to("scheduled"));

  const cancelFlow = await getSetting(shop.id, "cancelFlow");
  if (!cancelFlow.enabled) {
    // Flow disabled → pure 2-click cancel: confirm page, no offers anywhere.
    return redirect(to("confirm"));
  }

  // Reuse a fresh in-progress session (refresh-safe); otherwise start one —
  // startCancelSession abandons stale sessions and logs cancel.flow_started.
  // Preview sessions record nothing: the admin walks the UI, no CancelSession.
  if (!ctx.portalSession.isPreview) {
    const session = await getActiveSession(contract.id);
    if (!session) {
      await startCancelSession(contract.id, "PORTAL");
    }
  }

  const [summary, pauseSettings, portalSettings] = await Promise.all([
    buildRetentionSummary(shop, contract),
    getSetting(shop.id, "pause"),
    getSetting(shop.id, "portal"),
  ]);

  // Already PAUSED (v1.28.0 review fix): the one-tap pause would be a no-op
  // recorded as a save (acceptSave refuses it) — offer the exit ramp (extend
  // the hold) instead. A hold WITHOUT a resume day (paused from the Shopify
  // admin / synced externally / legacy) gets the note only: no pause CTA,
  // never a dead primary button.
  const paused =
    contract.status === "PAUSED"
      ? {
          resumeAt: contract.resumeAt ?? null,
          choices: contract.resumeAt
            ? pauseExtendChoices({
                resumeAt: contract.resumeAt,
                pausedAt: contract.pausedAt,
                weeks: (portalSettings as { pauseExtendChoicesWeeks?: unknown[] })
                  .pauseExtendChoicesWeeks,
                maxMonths: pauseSettings.maxMonths,
                tz: shop.ianaTimezone,
              })
            : [],
        }
      : null;

  return renderCancelPage(ctx, pageIntro({
    paused,
    // Plan lock window (P3.8): no one-tap pause (a reduction); the flow
    // schedules the cancellation for the unlock day instead.
    locked: ctx.lock.locked && ctx.lock.until ? { until: ctx.lock.until } : null,
    locale,
    csrf: ctx.portalSession.csrfToken,
    contractId: contract.id,
    firstName: contract.firstName,
    summary,
    tz: shop.ianaTimezone,
    copyVariant: copyVariantFor(contract.id),
    pauseMonths: Math.min(cancelFlow.pauseSuggestMonths, pauseSettings.maxMonths),
    showError: new URL(request.url).searchParams.has("error"),
    previewToken: ctx.portalSession.previewToken,
  }));
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const ctx = await requireCancelContext(request, params.id);
  const { contract, locale } = ctx;
  const to = (step?: string, error = false) =>
    withLocale(
      `${cancelPublicPath(contract.id, step)}${error ? "?error=1" : ""}`,
      locale,
      ctx.portalSession.previewToken,
    );

  if (contract.status === "CANCELLED") return redirect(to("done"));

  const form = await request.formData();
  if (!csrfOk(ctx, form)) return redirect(to(undefined, true));

  const intent = String(form.get("intent") ?? "");

  // Preview sessions: navigation works, mutations never execute — the one-tap
  // pause bounces back with the preview toast instead of calling the engine.
  if (ctx.portalSession.isPreview) {
    if (
      intent === "pause" ||
      intent === "extend_pause" ||
      intent === "keep_scheduled" ||
      intent === "cancel_now"
    ) {
      const base = to();
      const sep = base.includes("?") ? "&" : "?";
      return redirect(`${base}${sep}toast=preview_blocked`);
    }
    return redirect(to("reason"));
  }

  if (intent === "keep_scheduled") {
    // "Keep my subscription" on a scheduled cancel (P3.8): clears the
    // schedule atomically; the scheduled page then reads "you're staying".
    try {
      await keepScheduledCancel(contract.id, {
        source: "CUSTOMER_PORTAL",
        actor: "customer",
      });
    } catch (err) {
      console.error("[cancel] keep scheduled cancel failed", contract.id, err);
      return redirect(to("scheduled", true));
    }
    return redirect(to("scheduled"));
  }

  if (intent === "cancel_now") {
    // "Cancel now instead" on the scheduled page (P3.8): only when the lock
    // has lifted since scheduling — the customer already asked to end the
    // subscription; making them keep-then-re-enter would be a dark pattern.
    // Still locked (stale page) → the schedule stands untouched.
    if (!contract.cancelScheduledAt || ctx.lock.locked) return redirect(to("scheduled"));
    try {
      const session =
        (await getActiveSession(contract.id)) ??
        (await startCancelSession(contract.id, "PORTAL"));
      await completeCancel(session.id, "customer");
      return redirect(to("done"));
    } catch (err) {
      console.error("[cancel] cancel_now failed", contract.id, err);
      return redirect(to("scheduled", true));
    }
  }

  // Inside the plan lock window (P3.8) the one-tap pause is not offered and
  // acceptSave refuses it — nothing to execute; on to the survey.
  if (ctx.lock.locked && (intent === "pause" || intent === "extend_pause")) {
    return redirect(to("reason"));
  }

  if (intent === "pause") {
    const session =
      (await getActiveSession(contract.id)) ??
      (await startCancelSession(contract.id, "PORTAL"));
    const monthsRaw = Number(form.get("months"));
    const months =
      Number.isInteger(monthsRaw) && monthsRaw >= 1 && monthsRaw <= 6
        ? monthsRaw
        : PAUSE_SUGGEST_MONTHS;
    try {
      await acceptSave(session.id, "PAUSE", { months });
      return redirect(to("saved"));
    } catch (err) {
      console.error("[cancel] one-tap pause failed", contract.id, err);
      return redirect(to(undefined, true));
    }
  }

  if (intent === "extend_pause") {
    // Pause exit ramp for an already-PAUSED contract: acceptSave refuses on
    // any other status and requires the weeks to be an offered choice.
    const session =
      (await getActiveSession(contract.id)) ??
      (await startCancelSession(contract.id, "PORTAL"));
    const weeksRaw = Number(form.get("weeks"));
    if (!Number.isInteger(weeksRaw) || weeksRaw < 1) return redirect(to(undefined, true));
    try {
      await acceptSave(session.id, "EXTEND_PAUSE", { weeks: weeksRaw });
      return redirect(to("saved"));
    } catch (err) {
      console.error("[cancel] one-tap extend-pause failed", contract.id, err);
      return redirect(to(undefined, true));
    }
  }

  // Default: continue to the reason survey.
  return redirect(to("reason"));
};
