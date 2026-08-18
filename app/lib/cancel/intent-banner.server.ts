import prisma from "~/db.server";
import { logEvent } from "~/lib/events/log.server";
import { t } from "~/lib/i18n/i18n.server";
import { escapeHtml, withLocale } from "~/lib/portal/layout.server";
import { PORTAL_BASE_PATH } from "~/lib/portal/session.server";
import { formatFrequency, frequencyToken } from "~/lib/frequency";
import type { LocalContractWithLines } from "~/lib/contracts/shared.server";
import {
  findAbandonedIntent,
  intentActionsFor,
  intentApplicability,
  pausedSince,
  type AbandonedIntent,
  type IntentApplicability,
} from "./intent-followup.server";

/**
 * Portal home "Thinking of pausing? Here are your options" banner (v1.28.0,
 * P3.6) — the in-portal twin of the cancel-intent follow-up email. For
 * `cancelFlow.intentBannerDays` (default 14) after a walked-away cancel
 * session it offers the SAME reason-matched actions the email carries
 * (`intentActionsFor` + `intentApplicability` — one truth), posted through
 * the portal's own dispatcher (skip / delay / frequency / pause), a
 * "make my order smaller" link to the subscription page, "talk to us"
 * (Account → Get help) and a plain "I still want to cancel" link to the
 * cancel page. Deliberately OUTSIDE the growth helpers (portal.intent.* keys
 * are not in the growth-copy scope): this is the cancel-flow context and may
 * name cancelling factually — neutral tone, no countdown, no forced offer.
 *
 * Reads only; renders nothing on any failure. `cancel.intent_banner_shown`
 * is logged once per session per shop-day for real customers.
 */

export interface IntentBannerContext {
  shopId: string;
  tz: string;
  locale: string;
  csrf: string;
  preview: string | null;
  isPreview: boolean;
  bannerDays: number;
  downsizeEnabled: boolean;
  /** Preparing state per contract id (P2.1) — the one-tap edits hide inside it. */
  preparingByContract: ReadonlyMap<string, boolean>;
  supportAvailable: boolean;
  now?: Date;
}

/** The first (most recently abandoned) live intent among the contracts. */
export async function findBannerIntent(
  contracts: LocalContractWithLines[],
  opts: { now: Date; bannerDays: number },
): Promise<{ contract: LocalContractWithLines; intent: AbandonedIntent } | null> {
  if (opts.bannerDays <= 0) return null;
  const maxAgeMs = opts.bannerDays * 86_400_000;
  let best: { contract: LocalContractWithLines; intent: AbandonedIntent } | null = null;
  for (const contract of contracts) {
    if (contract.isDemo) continue;
    if (contract.status !== "ACTIVE" && contract.status !== "PAUSED") continue;
    if (contract.cancelScheduledAt) continue;
    const intent = await findAbandonedIntent(contract.id, { now: opts.now, maxAgeMs });
    if (!intent) continue;
    // A pause taken after walking away is the decision (same rule as the
    // sweep — "never after a pause"); an already-paused contract stays.
    if (pausedSince(contract, intent.completedAt)) continue;
    if (!best || intent.completedAt.getTime() > best.intent.completedAt.getTime()) {
      best = { contract, intent };
    }
  }
  return best;
}

/** Pure HTML for the banner given resolved applicability. Exported for tests. */
export function intentBannerHtml(input: {
  locale: string;
  contract: { id: string; nextBillingDate: Date | null };
  intent: AbandonedIntent;
  applicable: IntentApplicability;
  csrf: string;
  preview: string | null;
  supportAvailable: boolean;
}): string {
  const { locale, contract, applicable, csrf, preview } = input;
  const tr = (key: string, v?: Record<string, string | number>) => t(locale, key, v);
  const api = (action: string) =>
    withLocale(`${PORTAL_BASE_PATH}/api/${action}`, locale, preview);
  const manageHref = withLocale(
    `${PORTAL_BASE_PATH}/subscription/${contract.id}`,
    locale,
    preview,
  );
  const cancelHref = withLocale(`${PORTAL_BASE_PATH}/cancel/${contract.id}`, locale, preview);
  const supportHref = `${withLocale(`${PORTAL_BASE_PATH}/account`, locale, preview)}#cxs-support`;
  const expectedNext = contract.nextBillingDate?.toISOString() ?? "";
  const hidden = (fields: Array<[string, string]>) =>
    [
      ["contractId", contract.id],
      ["_csrf", csrf],
      ["return_to", "/"],
      ...fields,
    ]
      .map(
        ([n, v]) =>
          `<input type="hidden" name="${escapeHtml(n)}" value="${escapeHtml(v)}">`,
      )
      .join("");
  const form = (action: string, fields: Array<[string, string]>, label: string) =>
    `<form method="post" action="${escapeHtml(api(action))}">${hidden(fields)}<button type="submit" class="cxs-btn cxs-btn--ghost cxs-btn--small">${escapeHtml(label)}</button></form>`;

  const actions: string[] = [];
  for (const action of intentActionsFor(input.intent.reason)) {
    switch (action) {
      case "SKIP":
        if (applicable.skip) {
          actions.push(form("skip", [["expected_next", expectedNext]], tr("portal.intent.skip")));
        }
        break;
      case "DELAY":
        if (applicable.delay) {
          actions.push(
            form(
              "delay",
              [
                ["weeks", "3"],
                ["expected_next", expectedNext],
              ],
              tr("portal.intent.delay"),
            ),
          );
        }
        break;
      case "SLOWER":
        if (applicable.slower) {
          actions.push(
            form(
              "frequency",
              [["frequency", frequencyToken(applicable.slower)]],
              tr("portal.intent.slower", {
                frequency: formatFrequency(tr, "every", applicable.slower),
              }),
            ),
          );
        }
        break;
      case "DOWNSIZE":
        if (applicable.downsize) {
          actions.push(
            `<a class="cxs-btn cxs-btn--ghost cxs-btn--small" href="${manageHref}">${escapeHtml(tr("portal.intent.downsize"))}</a>`,
          );
        }
        break;
      case "PAUSE":
        if (applicable.pause) {
          actions.push(form("pause", [["months", "1"]], tr("portal.intent.pause")));
        }
        break;
    }
  }
  if (input.supportAvailable) {
    actions.push(
      `<a class="cxs-btn cxs-btn--ghost cxs-btn--small" href="${supportHref}">${escapeHtml(tr("portal.intent.talk"))}</a>`,
    );
  }
  if (actions.length === 0) return "";

  return `<div class="cxs-banner cxs-intent" data-cxs-intent-reason="${escapeHtml(input.intent.reason ?? "")}"><p class="cxs-intent__title" style="margin:0 0 4px;font-weight:600">${escapeHtml(tr("portal.intent.title"))}</p><p class="cxs-muted cxs-small" style="margin:0 0 10px">${escapeHtml(tr("portal.intent.body"))}</p><div class="cxs-row cxs-intent__actions">${actions.join("")}</div><p class="cxs-small" style="margin:10px 0 0"><a class="cxs-muted" style="color:var(--cxs-muted)" href="${cancelHref}">${escapeHtml(tr("portal.intent.cancel_link"))}</a></p></div>`;
}

/**
 * Resolve + render the banner for the portal home. Contained: any failure
 * renders nothing. Logs `cancel.intent_banner_shown` (once per session per
 * shop-day) for real customers only.
 */
export async function renderIntentBanner(
  contracts: LocalContractWithLines[],
  ctx: IntentBannerContext,
): Promise<string> {
  try {
    const now = ctx.now ?? new Date();
    const hit = await findBannerIntent(contracts, { now, bannerDays: ctx.bannerDays });
    if (!hit) return "";
    const applicable = await intentApplicability(ctx.shopId, ctx.tz, hit.contract, {
      preparing: ctx.preparingByContract.get(hit.contract.id) ?? false,
      downsizeEnabled: ctx.downsizeEnabled,
      now,
    });
    const html = intentBannerHtml({
      locale: ctx.locale,
      contract: hit.contract,
      intent: hit.intent,
      applicable,
      csrf: ctx.csrf,
      preview: ctx.preview,
      supportAvailable: ctx.supportAvailable,
    });
    if (html && !ctx.isPreview) {
      await logBannerShown(ctx.shopId, ctx.tz, hit.contract, hit.intent, now);
    }
    return html;
  } catch (err) {
    console.error("[portal] cancel-intent banner failed", err);
    return "";
  }
}

async function logBannerShown(
  shopId: string,
  tz: string,
  contract: LocalContractWithLines,
  intent: AbandonedIntent,
  now: Date,
): Promise<void> {
  try {
    const { shopDayStartUtc } = await import("~/lib/dates.server");
    const dayStart = shopDayStartUtc(now, tz);
    const already = await prisma.subscriberEvent.findFirst({
      where: {
        shopId,
        contractId: contract.id,
        type: "cancel.intent_banner_shown",
        createdAt: { gte: dayStart },
        payload: { path: ["sessionId"], equals: intent.sessionId },
      },
      select: { id: true },
    });
    if (already) return;
    await logEvent({
      shopId,
      contractId: contract.id,
      customerId: contract.customerId,
      email: contract.email,
      type: "cancel.intent_banner_shown",
      source: "CUSTOMER_PORTAL",
      actor: "customer",
      payload: { sessionId: intent.sessionId, reason: intent.reason, step: intent.step },
    });
  } catch (err) {
    console.error("[portal] cancel-intent banner event failed", err);
  }
}
