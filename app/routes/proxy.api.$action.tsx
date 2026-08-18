import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { z } from "zod";
import prisma from "~/db.server";
import { authenticate, adminClientForShop } from "~/shopify.server";
import { requireShop } from "~/lib/shop/install.server";
import { getSetting } from "~/lib/settings/settings.server";
import { t } from "~/lib/i18n/i18n.server";
import { addDaysTz, addIntervalTz, shopDayStartUtc } from "~/lib/dates.server";
import { resolveCardUpdatePath } from "~/lib/payments/cardUpdate.server";
import { requestCustomerRetry } from "~/lib/dunning/engine.server";
import { skipFailedCycleAndResume } from "~/lib/dunning/skip-resume.server";
import { OPEN_CASE_STATES } from "~/lib/dunning/states";
import { loadPortalDunning } from "~/lib/portal/dunning.server";
import { resolvePortalThreeDs } from "~/lib/portal/threeds.server";
import {
  invalidatePaymentMethodsCache,
  isPaymentMethodGid,
  paymentMethodErrorToast,
} from "~/lib/portal/payment-methods.server";
import {
  addLine,
  addOneTimeAddon,
  changeFrequency,
  changeLineQuantity,
  delayNextCycle,
  delaySchedule,
  extendPause,
  maxPauseResumeAt,
  pauseContract,
  pauseUntil,
  removeLine,
  resumeContract,
  sendNextOrderTomorrow,
  setDeliveryInstructions,
  setLineQuantityThisCycle,
  setNextBillingDate,
  skipLineThisCycle,
  skipNextCycle,
  swapLineVariant,
  unskipLineThisCycle,
  unskipNextCycle,
  updateDeliveryAddress,
  changePaymentMethod,
  setBackupPaymentMethod,
  CycleLineEditError,
  PauseUntilError,
  SendTomorrowError,
} from "~/lib/contracts/service.server";

/** ContractEditBlockedError (contracts service) — Shopify refused a
 * contract-level edit while billing-cycle edits are staged (v1.28.0). */
function isContractEditBlocked(err: unknown): boolean {
  return err instanceof Error && err.name === "ContractEditBlockedError";
}
import { pauseExtendChoices } from "~/lib/portal/flex.server";
import { isKnownCountry, normalizeProvinceCode } from "~/lib/portal/countries";
import type { DeliveryAddressInput } from "~/lib/graphql/index.server";
import { reactivateWithCurrentOffer } from "~/lib/winback/restart.server";
import { logEvent } from "~/lib/events/log.server";
import { isSetupMode } from "~/lib/launch/launch.server";
import {
  escapeHtml,
  localeFromRequest,
  portalPage,
  closedPortalPage,
  withLocale,
} from "~/lib/portal/layout.server";
import {
  PORTAL_BASE_PATH,
  getPortalSession,
  loginRedirectUrl,
  verifyCsrf,
} from "~/lib/portal/session.server";
import { frequencyOptionsForContract } from "~/lib/portal/catalog.server";
import {
  contractFrequency,
  frequencyToken,
  parseFrequencyToken,
  sameFrequency,
  type Frequency,
} from "~/lib/frequency";
import { calendarDayIn, delayModeFor } from "~/lib/portal/schedule.server";
import {
  mintUndoToken,
  performUndo,
  readUndoToken,
  undoWindowSeconds,
  type UndoSpec,
} from "~/lib/portal/undo.server";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";
import { resolveLockState, type LockState } from "~/lib/contracts/lock.server";
import {
  isPreparingOrder,
  resolveChargeTiming,
} from "~/lib/billing/timing.server";
import {
  followingFromDelayEvent,
  loadNewestDelayEvent,
} from "~/lib/billing/following-date.server";
import {
  isSupportTopic,
  normalizeSupportMessage,
  resolveOrderRef,
  submitSupportRequest,
} from "~/lib/support/request.server";

/**
 * Single POST dispatcher for every portal mutation:
 *   /apps/cellexia-subs/api/{skip|unskip|delay|frequency|swap|quantity|add_line|
 *                       remove_line|addon|pause|resume|reactivate|next_date|
 *                       address|payment_update|payment_retry|payment_3ds|
 *                       payment_select|payment_backup|payment_skip_and_resume|undo|
 *                       support|line_skip|line_unskip|line_qty_once|
 *                       pause_until|pause_extend|pause_resume_date|
 *                       send_tomorrow|delivery_instructions}
 *
 * Guard order: proxy signature → portal session → CSRF → rate limit →
 * contract ownership → per-action input validation → contracts service with
 * { source: CUSTOMER_PORTAL, actor: "customer" } (the service logs the
 * canonical event). Success and failure both land back on the referring page
 * with a localized ?toast= key; nothing internal ever leaks to the customer.
 *
 * Double submits: one-tap cycle mutations (skip/delay) carry the cycle date
 * they target in `expected_next`; when the contract has already advanced past
 * it (double-tap, retry, second tab) the request is a no-op that returns the
 * same success toast. Pause/resume short-circuit the same way on status.
 * addon/add_line have no cycle date to compare, so their double-tap guard
 * lives at the RESOURCE instead: the contracts service claims the mirror
 * line under a unique addClaimKey before the multi-second Shopify edit
 * (migration 0009), and the losing request returns the same success toast
 * without staging anything — the customer can never be charged twice for
 * one tap, whichever request wins.
 */

const weeksSchema = z.coerce.number().int().min(1).max(12);
const frequencyWeeksSchema = z.coerce.number().int().min(1).max(52);
const monthsSchema = z.coerce.number().int().min(1).max(3);
const quantityBaseSchema = z.coerce.number().int().min(1);
const variantGidSchema = z
  .string()
  .regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// Pause-extension choice (v1.28.0, P2.6): membership in the merchant's
// settings list is checked in the case body, this only bounds the shape.
const extendWeeksSchema = z.coerce.number().int().min(1).max(26);

const addressFormSchema = z.object({
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  company: z.string().trim().max(100).optional(),
  address1: z.string().trim().min(1).max(200),
  address2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(100),
  // Region: a code (≤5 — Shopify's longest, e.g. "TAMPS") or, from the
  // free-text fallback, a region name; normalised against the country's
  // table in the case body.
  provinceCode: z.string().trim().max(60).optional(),
  countryCode: z
    .string()
    .trim()
    .length(2)
    .transform((v) => v.toUpperCase()),
  zip: z.string().trim().min(1).max(20),
  phone: z.string().trim().max(30).optional(),
});

function sanitizeReturnTo(value: unknown): string {
  const raw = typeof value === "string" ? value : "/";
  // "/account" (v1.28.0): the Account page hosts the Get-help form.
  return /^\/(subscription\/[A-Za-z0-9_-]+|account)?$/.test(raw) ? raw : "/";
}

function backRedirect(
  locale: string,
  returnTo: string,
  toast: string,
  preview: string | null,
  extra?: Record<string, string>,
) {
  const path = returnTo === "/" ? `${PORTAL_BASE_PATH}/` : `${PORTAL_BASE_PATH}${returnTo}`;
  const params = new URLSearchParams({ toast, ...(extra ?? {}) });
  return redirect(withLocale(`${path}?${params.toString()}`, locale, preview));
}

function str(form: FormData, name: string): string {
  return String(form.get(name) ?? "");
}

function rateLimitedHtml(locale: string, preview: string | null): string {
  return portalPage({
    locale,
    title: t(locale, "portal.rate_limited.title"),
    body: `<div class="cxs-card"><p style="margin:0 0 8px">${escapeHtml(t(locale, "portal.rate_limited.body"))}</p><a class="cxs-btn cxs-btn--quiet cxs-btn--small" href="${withLocale(`${PORTAL_BASE_PATH}/`, locale, preview)}">${escapeHtml(t(locale, "portal.rate_limited.back"))}</a></div>`,
    activeNav: "subscriptions",
    previewToken: preview,
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);
  throw new Response("Method Not Allowed", { status: 405 });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { liquid, session } = await authenticate.public.appProxy(request);
  if (!session) throw new Response("Unauthorized", { status: 401 });
  if (request.method !== "POST") {
    throw new Response("Method Not Allowed", { status: 405 });
  }

  const locale = localeFromRequest(request);
  // loginRedirectUrl (not a bare /login) so a POST whose cx_pp expired
  // mid-preview carries the token to the login page, which then names the
  // expired preview instead of showing the generic gate.
  const loginUrl = loginRedirectUrl(request);

  const portalSession = await getPortalSession(request);
  if (!portalSession) throw redirect(loginUrl);

  const form = await request.formData();
  if (!verifyCsrf(portalSession, str(form, "_csrf"))) {
    throw new Response("Forbidden", { status: 403 });
  }

  const shop = await requireShop(session.shop);
  if (portalSession.shopId !== shop.id) throw redirect(loginUrl);

  // ── Preview sessions are read-only: nothing executes, no Shopify calls ─────
  // The redirect carries the cx_pp token (backRedirect's preview parameter):
  // the proxy strips cookies, so dropping it here would sign the admin out of
  // their own preview on the very first blocked click.
  if (portalSession.isPreview) {
    return backRedirect(
      locale,
      sanitizeReturnTo(form.get("return_to")),
      "preview_blocked",
      portalSession.previewToken,
    );
  }

  // ── Launch gate: a closed portal takes no mutations (stale sessions) ───────
  if (await isSetupMode(shop.id)) {
    return liquid(closedPortalPage(request, locale), {
      headers: { "X-Robots-Tag": "noindex" },
    });
  }

  const portalSettings = await getSetting(shop.id, "portal");

  // ── Rate limit: portal mutations per rolling hour per customer ─────────────
  // Insert-then-count: this attempt is recorded FIRST, so every concurrent
  // request sees at least its own row and a burst cannot slip past a
  // read-then-act window (the old counter read committed events only and each
  // action logged its event after completing). Attempt rows carry no
  // contractId, keeping contract timelines clean; the type is unmapped in the
  // Klaviyo event map so nothing is forwarded.
  await logEvent({
    shopId: shop.id,
    customerId: portalSession.customerId,
    email: portalSession.email,
    type: "portal.mutation_attempt",
    source: "CUSTOMER_PORTAL",
    actor: "customer",
    payload: { action: params.action ?? "" },
  });
  const recentAttempts = await prisma.subscriberEvent.count({
    where: {
      shopId: shop.id,
      customerId: portalSession.customerId,
      source: "CUSTOMER_PORTAL",
      type: "portal.mutation_attempt",
      createdAt: { gte: new Date(Date.now() - 3600_000) },
    },
  });
  // Strictly greater: the count includes the attempt just inserted.
  if (recentAttempts > portalSettings.mutationsPerHour) {
    return liquid(rateLimitedHtml(locale, portalSession.previewToken), 429);
  }

  const returnTo = sanitizeReturnTo(form.get("return_to"));
  const back = (toast: string, extra?: Record<string, string>) =>
    backRedirect(locale, returnTo, toast, portalSession.previewToken, extra);

  // Bounds come from settings so the form (subscription page) and this
  // validator share ONE source and cannot silently drift apart.
  const quantitySchema = quantityBaseSchema.max(portalSettings.maxLineQuantity);

  // ── Ownership: the contract must belong to this shop AND this customer ─────
  const contract = await prisma.subscriptionContract.findFirst({
    where: {
      id: str(form, "contractId"),
      shopId: shop.id,
      customerId: portalSession.customerId,
      // OURS_ONLY — the single gate for EVERY portal mutation below. A contract
      // belonging to the store's other subscription app resolves to nothing, so
      // skip/pause/cancel/swap/address/... can never reach it. Editing it would
      // rewrite another app's contract on Shopify behind its back.
      ...OURS_ONLY,
    },
    include: { lines: true },
  });
  if (!contract) {
    return backRedirect(locale, "/", "not_found", portalSession.previewToken);
  }

  const actionName = params.action ?? "";
  const shopDomain = session.shop;
  const opts = { source: "CUSTOMER_PORTAL" as const, actor: "customer" };

  // Friendly idempotency for status toggles: a double-tap whose first request
  // already landed reports success instead of a confusing error.
  if (actionName === "pause" && contract.status === "PAUSED") {
    return back("paused");
  }
  // pause_until on an already-paused contract: the hold is in place — a
  // double-tap reports it (a different day would be extend/resume territory,
  // which the PAUSED banner offers instead).
  if (actionName === "pause_until" && contract.status === "PAUSED") {
    return back("paused");
  }
  if (actionName === "resume" && contract.status === "ACTIVE") {
    // Same dated confirmation as the real resume (the standing next order).
    return back(
      "resumed",
      contract.nextBillingDate
        ? { d1: calendarDayIn(contract.nextBillingDate, shop.ianaTimezone) }
        : {},
    );
  }
  if (actionName === "reactivate" && contract.status === "ACTIVE") {
    return back("restarted");
  }

  const ACTIVE_ONLY = new Set([
    "skip",
    "unskip",
    "delay",
    "frequency",
    "swap",
    "quantity",
    "add_line",
    "remove_line",
    "addon",
    "pause",
    "next_date",
    "undo",
    // Per-line cycle edits (v1.28.0, P2.5) target the UPCOMING cycle.
    "line_skip",
    "line_unskip",
    "line_qty_once",
    // Date-based hold (P2.6) starts from ACTIVE; "send tomorrow" (P2.7)
    // pulls an ACTIVE contract's upcoming order.
    "pause_until",
    "send_tomorrow",
  ]);
  if (ACTIVE_ONLY.has(actionName) && contract.status !== "ACTIVE") {
    return back("error");
  }

  // Editable-only actions mirror the detail loader's `editable` rule
  // (ACTIVE || PAUSED). Without this, a crafted POST could update the
  // delivery address of a CANCELLED/EXPIRED contract — a write the portal UI
  // never offers and the rest of the app does not expect on dead contracts.
  // delivery_instructions (P2.8) is a delivery-detail edit like address.
  const EDITABLE_ONLY = new Set(["address", "delivery_instructions"]);
  if (
    EDITABLE_ONLY.has(actionName) &&
    contract.status !== "ACTIVE" &&
    contract.status !== "PAUSED"
  ) {
    return back("error");
  }

  // Payment-recovery verbs (v1.28.0): ACTIVE / PAUSED / FAILED only — a
  // CANCELLED or EXPIRED contract has no held payment to retry or confirm.
  // Never lock-blocked (recoveries), rate limited above like every action.
  // payment_select / payment_backup (P1.7) are recoveries too: choosing
  // another vaulted card is exactly what a failed or expiring card needs.
  const RECOVERY_ONLY = new Set([
    "payment_retry",
    "payment_3ds",
    "payment_select",
    "payment_backup",
    // Skip the held order and continue (P1.9): FAILED only in practice —
    // the service refuses every other status with a typed outcome.
    "payment_skip_and_resume",
  ]);
  if (
    RECOVERY_ONLY.has(actionName) &&
    contract.status !== "ACTIVE" &&
    contract.status !== "PAUSED" &&
    contract.status !== "FAILED"
  ) {
    return back("error");
  }

  // ── Plan lock window (SellingPlanConfig.lockDays) ──────────────────────────
  // Inside the window every schedule reduction is refused; additions
  // (add_line/addon/quantity increase) and recoveries (unskip, resume,
  // reactivate, address, payment_update) stay available. "quantity" and
  // "remove_line" are shape-dependent (an increase is additive; removing a
  // self-added one-time addon just undoes an addition), so their case bodies
  // re-check against this state. The lock is resolved only for actions it
  // can affect — everything else skips the extra query.
  const LOCK_BLOCKED = new Set([
    "skip",
    "delay",
    "frequency",
    "next_date",
    "pause",
    "swap",
    // Date-based hold and its extension (P2.6) are pauses — REDUCING, like
    // "pause". send_tomorrow (acceleration) and delivery_instructions
    // (delivery detail) are never lock-blocked.
    "pause_until",
    "pause_extend",
  ]);
  let lock: LockState = { locked: false, until: null, lockDays: 0 };
  if (
    LOCK_BLOCKED.has(actionName) ||
    actionName === "quantity" ||
    actionName === "remove_line" ||
    actionName === "line_skip" ||
    actionName === "line_qty_once"
  ) {
    lock = await resolveLockState(shop.id, contract, shop.ianaTimezone);
  }
  // Friendly lock refusals (v1.19.0): when the merchant's friendly messaging
  // is on, the redirect carries the unlock day (shop-tz calendar label) and
  // the remaining-day count so the toast can say WHEN and what remains
  // available instead of a bare refusal. resolveToast treats the params as
  // untrusted and falls back to the classic copy on anything malformed.
  const lockedBack = () => {
    if (portalSettings.friendlyLockMessaging && lock.until) {
      const label = new Intl.DateTimeFormat("en-CA", {
        timeZone: shop.ianaTimezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(lock.until);
      const daysToGo = Math.max(
        1,
        Math.ceil((lock.until.getTime() - Date.now()) / 86_400_000),
      );
      return back("locked", {
        locked_until: label,
        locked_days: String(daysToGo),
      });
    }
    return back("locked");
  };

  if (lock.locked && LOCK_BLOCKED.has(actionName)) {
    return lockedBack();
  }

  // ── Preparing-your-order window (v1.28.0, P2.1) ────────────────────────────
  // Once the billing day's charge moment has passed (or an attempt is in
  // flight) the portal hides skip / delay / next_date / frequency / swap; a
  // stale page or crafted POST is refused here with the same explanation, so
  // the UI state and the dispatcher never disagree on what the cycle allows.
  // Recoveries, additions, pause, address and payment stay available. The
  // read is contained (isPreparingOrder answers false on any failure).
  // `undo` is in the set too (review fix): an undo moves the schedule exactly
  // like the verbs it reverses, and must not land while an attempt is in
  // flight (a stale tab / a 14-day-old token can arrive at any time).
  const PREPARING_BLOCKED = new Set([
    "skip",
    "delay",
    "frequency",
    "next_date",
    "swap",
    "undo",
    // Per-line cycle edits (P2.5) edit the cycle being prepared too.
    "line_skip",
    "line_unskip",
    "line_qty_once",
  ]);
  if (PREPARING_BLOCKED.has(actionName)) {
    const timing = await resolveChargeTiming(shop.id, shop.ianaTimezone);
    if (await isPreparingOrder(contract, timing)) {
      return back("preparing");
    }
  }

  // ── Open dunning case owns the cycle (v1.28.0 audit) ───────────────────────
  // While a case is open the mirror's nextBillingDate is already
  // held+interval (advanced at attempt creation, not resynced by the failure
  // webhook), so a schedule verb would silently edit cycle N+1 while cycle N
  // is still retrying — and the customer would believe they skipped the held
  // order. The detail page hides the schedule card in that state; a stale
  // page or crafted POST is refused here with a typed toast (the payment
  // banner's verbs are the cycle actions). sendNextOrderTomorrow already
  // refuses the same way in the service. Undo / unskip / swap stay: they
  // restore or do not move the schedule.
  const DUNNING_BLOCKED = new Set([
    "skip",
    "delay",
    "frequency",
    "next_date",
    "line_skip",
    "line_unskip",
    "line_qty_once",
  ]);
  if (DUNNING_BLOCKED.has(actionName)) {
    // Contained like the preparing read: a failed case lookup never blocks
    // the action (the service-level guards still hold).
    let openCase: { id: string } | null = null;
    try {
      openCase = await prisma.dunningCase.findFirst({
        where: { contractId: contract.id, state: { in: OPEN_CASE_STATES } },
        select: { id: true },
      });
    } catch (err) {
      console.error("[portal] open-case read failed", contract.id, err);
    }
    if (openCase) return back("payment_issue_schedule");
  }

  const ownedLine = (lineId: string) =>
    contract.lines.find((l) => l.id === lineId) ?? null;

  /**
   * Cycle-level dedupe for one-tap mutations: the form embeds the
   * nextBillingDate it was rendered against; if the contract has already
   * moved past it, this POST is a duplicate (double-tap / retry / second
   * tab) — report success without executing, so one accidental double-tap
   * can never skip or delay two cycles. Missing field ⇒ no dedupe.
   */
  const isDuplicateCycleSubmit = (): boolean => {
    const expected = str(form, "expected_next");
    if (!expected || !contract.nextBillingDate) return false;
    return contract.nextBillingDate.toISOString() !== expected;
  };

  // ── Schedule toasts + Undo (v1.28.0, P2.2) ─────────────────────────────────
  // The confirming redirect carries the shop-tz calendar days of the next
  // AND the following order (d1/d2), the frequency token, the delay mode, and
  // a signed undo token bound to shop+contract+customer that restores the
  // pre-action value (undo.server.ts). resolveToast validates every param
  // as untrusted; the token is contained — no token, no Undo, action intact.
  const tz = shop.ianaTimezone;
  const cadence = contractFrequency(contract);
  const followingOf = (next: Date | null): Date | null =>
    next ? addIntervalTz(next, cadence.unit, cadence.count, tz) : null;
  const undoParam = (spec: UndoSpec): Record<string, string> => {
    const token = mintUndoToken(
      spec,
      { shopId: shop.id, contractId: contract.id, customerId: contract.customerId },
      undoWindowSeconds(portalSettings),
    );
    return token ? { undo: token, cid: contract.id } : {};
  };
  const dayParams = (
    next: Date | null,
    following: Date | null,
  ): Record<string, string> => ({
    ...(next ? { d1: calendarDayIn(next, tz) } : {}),
    ...(following ? { d2: calendarDayIn(following, tz) } : {}),
  });

  try {
    switch (actionName) {
      case "skip": {
        if (isDuplicateCycleSubmit()) return back("skipped", { cid: contract.id });
        await skipNextCycle(shopDomain, contract.id, opts);
        return back("skipped", { cid: contract.id });
      }

      case "unskip": {
        // Idempotent in the service: nothing to unskip ⇒ no-op.
        await unskipNextCycle(shopDomain, contract.id, opts);
        return back("unskipped");
      }

      case "delay": {
        if (isDuplicateCycleSubmit()) return back("delayed");
        const weeks = weeksSchema.safeParse(form.get("weeks"));
        if (!weeks.success) return back("error");
        // portal.delayReanchors (v1.28.0, P2.2): ON → "Delay by N weeks"
        // moves the whole schedule (delaySchedule, set-next-date semantics)
        // unless the form asked for `mode=once` ("Just this once"); OFF →
        // today's one-cycle delayNextCycle whatever the form says.
        const mode = delayModeFor(portalSettings, str(form, "mode"));
        const before = contract.nextBillingDate;
        const updated =
          mode === "reanchor"
            ? await delaySchedule(shopDomain, contract.id, { weeks: weeks.data }, opts)
            : await delayNextCycle(shopDomain, contract.id, { weeks: weeks.data }, opts);
        const next = updated?.nextBillingDate ?? null;
        // once: the following order keeps the ORIGINAL rhythm — the anchor
        // the service just recorded (schedule-aware, so a second "just this
        // once" still names the true following order); reanchor: it follows
        // the new date.
        const following =
          mode === "once"
            ? ((next
                ? followingFromDelayEvent(
                    await loadNewestDelayEvent(contract.id),
                    next,
                  )
                : null) ?? followingOf(before))
            : followingOf(next);
        return back("delayed", {
          mode,
          every: frequencyToken(cadence),
          ...dayParams(next, following),
          ...(before && next
            ? undoParam({
                kind: "delay",
                mode,
                previousNextBillingDate: before.toISOString(),
                nextBillingDate: next.toISOString(),
              })
            : {}),
        });
      }

      case "frequency": {
        // v1.8.0 forms post a "frequency" token ("2:WEEK", "10:DAY"); the
        // bare "weeks" int keeps in-flight pages rendered before the deploy
        // working. A present-but-malformed token is an error, never a
        // fallback.
        const token = str(form, "frequency");
        const legacyWeeks = frequencyWeeksSchema.safeParse(form.get("weeks"));
        const freq: Frequency | null = token
          ? parseFrequencyToken(token)
          : legacyWeeks.success
            ? { unit: "WEEK", count: legacyWeeks.data }
            : null;
        if (!freq) return back("error");
        const { options, allowChoice } = await frequencyOptionsForContract(
          shop.id,
          contract,
        );
        // Exact {unit, count} membership — a cadence outside the offered set
        // (stale form, tampering) is rejected, as is any post when the
        // config disallows choice.
        if (!allowChoice || !options.some((o) => sameFrequency(o, freq))) {
          return back("error");
        }
        const before = contract.nextBillingDate;
        const updated = await changeFrequency(shopDomain, contract.id, freq, opts);
        const next = updated?.nextBillingDate ?? null;
        const following = next
          ? addIntervalTz(next, freq.unit, freq.count, tz)
          : null;
        return back("frequency_changed", {
          every: frequencyToken(freq),
          ...dayParams(next, following),
          ...(sameFrequency(cadence, freq)
            ? {}
            : undoParam({
                kind: "frequency",
                oldUnit: cadence.unit,
                oldCount: cadence.count,
                newUnit: freq.unit,
                newCount: freq.count,
                previousNextBillingDate: before ? before.toISOString() : null,
                nextBillingDate: next ? next.toISOString() : null,
              })),
        });
      }

      case "swap": {
        const line = ownedLine(str(form, "lineId"));
        const variantId = variantGidSchema.safeParse(form.get("variantId"));
        if (!line || line.isGift || !variantId.success) return back("error");
        await swapLineVariant(
          shopDomain,
          contract.id,
          line.id,
          variantId.data,
          opts,
        );
        return back("swapped");
      }

      case "quantity": {
        const line = ownedLine(str(form, "lineId"));
        const quantity = quantitySchema.safeParse(form.get("quantity"));
        if (!line || line.isGift || line.isOneTimeAddon || !quantity.success) {
          return back("error");
        }
        // Lock window blocks only the reducing direction — an increase is
        // additive and stays available.
        if (lock.locked && quantity.data < line.quantity) {
          return lockedBack();
        }
        await changeLineQuantity(
          shopDomain,
          contract.id,
          line.id,
          quantity.data,
          opts,
        );
        return back("quantity_changed");
      }

      case "add_line": {
        if (!portalSettings.allowAddProducts) return back("error");
        const variantId = variantGidSchema.safeParse(form.get("variantId"));
        const quantity = quantitySchema.safeParse(form.get("quantity") ?? "1");
        if (!variantId.success || !quantity.success) return back("error");
        await addLine(
          shopDomain,
          contract.id,
          variantId.data,
          quantity.data,
          { addedVia: "PORTAL" },
          opts,
        );
        return back("line_added");
      }

      case "remove_line": {
        const line = ownedLine(str(form, "lineId"));
        if (!line || line.isGift) return back("error");
        // Lock window blocks removing recurring lines (a plan reduction);
        // removing a one-time addon undoes an addition and stays available.
        if (lock.locked && !line.isOneTimeAddon) {
          return lockedBack();
        }
        if (!line.isOneTimeAddon) {
          const recurring = contract.lines.filter(
            (l) => !l.isGift && !l.isOneTimeAddon,
          );
          // Never let a customer empty their own contract from the portal.
          if (recurring.length <= 1) return back("cannot_remove_last");
        }
        await removeLine(shopDomain, contract.id, line.id, opts);
        return back("line_removed");
      }

      case "addon": {
        // Same merchant switch as add_line: the one-time add-on is the other
        // POST endpoint the add-products UI drives, and the OFF setting must
        // hold against a direct POST (stale page, replayed form), not just
        // hide the buttons.
        if (!portalSettings.allowAddProducts) return back("error");
        const variantId = variantGidSchema.safeParse(form.get("variantId"));
        const quantity = quantitySchema.safeParse(form.get("quantity") ?? "1");
        if (!variantId.success || !quantity.success) return back("error");
        await addOneTimeAddon(
          shopDomain,
          contract.id,
          variantId.data,
          quantity.data,
          { addedVia: "PORTAL" },
          opts,
        );
        return back("addon_added");
      }

      case "pause": {
        const months = monthsSchema.safeParse(form.get("months"));
        if (!months.success) return back("error");
        await pauseContract(shopDomain, contract.id, months.data, opts);
        return back("paused");
      }

      case "resume": {
        if (contract.status !== "PAUSED") return back("error");
        // The confirmation names the day the first order is charged (the
        // service schedules it ~3 days out when no day is chosen — P2.6 copy
        // truth): d1 rides on the redirect like every other schedule toast.
        const updated = await resumeContract(shopDomain, contract.id, opts);
        return back("resumed", dayParams(updated.nextBillingDate ?? null, null));
      }

      case "pause_until": {
        // Vacation hold with a resume DATE (v1.28.0, P2.6): the customer
        // picks the day deliveries resume (tomorrow … pause.maxMonths × 30
        // days) and optionally why (TRAVEL | TOO_MUCH | BUDGET | OTHER — the
        // service normalises anything else to null). The service owns the
        // bounds (typed refusals map to their own toasts) and the auto-resume
        // job bills ON that day. Lock-blocked like "pause" (above).
        const parsed = dateSchema.safeParse(form.get("date"));
        if (!parsed.success) return back("error");
        const candidate = shopDayStartUtc(
          new Date(`${parsed.data}T12:00:00Z`),
          tz,
        );
        if (Number.isNaN(candidate.getTime())) return back("error");
        try {
          const updated = await pauseUntil(shopDomain, contract.id, candidate, {
            ...opts,
            reason: str(form, "reason") || null,
          });
          return back("paused_until", {
            ...dayParams(updated.resumeAt ?? candidate, null),
          });
        } catch (err) {
          if (err instanceof PauseUntilError) {
            if (err.code === "RESUME_DATE_TOO_FAR") {
              return back("pause_too_far", {
                ...(err.maxResumeAt ? { d1: calendarDayIn(err.maxResumeAt, tz) } : {}),
              });
            }
            if (err.code === "RESUME_DATE_PAST") return back("pause_date_past");
            return back("error");
          }
          throw err;
        }
      }

      case "pause_extend": {
        // Pause exit ramp (P2.6): "need a little longer?" — one of the
        // merchant's week choices (settings.portal.pauseExtendChoicesWeeks)
        // added to the CURRENT resume day; membership is checked against the
        // same clamp the PAUSED banner rendered with (pauseExtendChoices), so
        // a stale or tampered form never moves a hold beyond the maximum.
        // The service re-validates and refuses (typed). PAUSED only.
        if (contract.status !== "PAUSED" || !contract.resumeAt) {
          return back("error");
        }
        // Double-submit dedupe (review fix): the banner embeds the resume day
        // it was rendered against (`expected_resume`); once the hold has
        // moved past it, this POST is a duplicate (double-tap / retry /
        // second tab) — report the standing hold, never move it again.
        // Missing field ⇒ no dedupe (same contract as expected_next).
        const expectedResume = str(form, "expected_resume");
        if (expectedResume && contract.resumeAt.toISOString() !== expectedResume) {
          return back("pause_extended", dayParams(contract.resumeAt, null));
        }
        const weeks = extendWeeksSchema.safeParse(form.get("weeks"));
        if (!weeks.success) return back("error");
        const pauseSettings = await getSetting(shop.id, "pause");
        const choice = pauseExtendChoices({
          resumeAt: contract.resumeAt,
          pausedAt: contract.pausedAt,
          weeks: portalSettings.pauseExtendChoicesWeeks,
          maxMonths: pauseSettings.maxMonths,
          tz,
        }).find((c) => c.weeks === weeks.data);
        if (!choice) return back("pause_too_far");
        try {
          const updated = await extendPause(
            shopDomain,
            contract.id,
            choice.resumeAt,
            opts,
          );
          return back("pause_extended", {
            ...dayParams(updated.resumeAt ?? choice.resumeAt, null),
          });
        } catch (err) {
          if (err instanceof PauseUntilError) {
            if (err.code === "RESUME_DATE_TOO_FAR") {
              return back("pause_too_far", {
                ...(err.maxResumeAt ? { d1: calendarDayIn(err.maxResumeAt, tz) } : {}),
              });
            }
            return back("error");
          }
          throw err;
        }
      }

      case "pause_resume_date": {
        // "Change resume date" on the PAUSED banner (P2.6): one date input,
        // dispatched by DIRECTION so the service verbs stay honest —
        //   later than the current resume day → extendPause (a REDUCTION:
        //     lock-gated here, same clamp as pause_extend);
        //   earlier → resumeContract({ billOn: day }) — the hold ends now and
        //     the first order is scheduled ON that day (a RECOVERY: never
        //     lock-gated). The toast says exactly that;
        //   the same day → nothing to do (reported as the standing hold);
        //   today or earlier → the "Resume now" button is the honest control.
        // PAUSED only.
        if (contract.status !== "PAUSED") return back("error");
        const parsed = dateSchema.safeParse(form.get("date"));
        if (!parsed.success) return back("error");
        const chosen = shopDayStartUtc(new Date(`${parsed.data}T12:00:00Z`), tz);
        if (Number.isNaN(chosen.getTime())) return back("error");
        const todayStart = shopDayStartUtc(new Date(), tz);
        if (chosen.getTime() <= todayStart.getTime()) return back("pause_date_past");
        const currentDay = contract.resumeAt
          ? shopDayStartUtc(contract.resumeAt, tz)
          : null;
        if (currentDay && chosen.getTime() === currentDay.getTime()) {
          return back("paused_until", dayParams(currentDay, null));
        }
        if (currentDay && chosen.getTime() > currentDay.getTime()) {
          const lockNow = await resolveLockState(shop.id, contract, shop.ianaTimezone);
          if (lockNow.locked) {
            lock = lockNow;
            return lockedBack();
          }
          try {
            const updated = await extendPause(shopDomain, contract.id, chosen, opts);
            return back("pause_extended", {
              ...dayParams(updated.resumeAt ?? chosen, null),
            });
          } catch (err) {
            if (err instanceof PauseUntilError) {
              if (err.code === "RESUME_DATE_TOO_FAR") {
                return back("pause_too_far", {
                  ...(err.maxResumeAt ? { d1: calendarDayIn(err.maxResumeAt, tz) } : {}),
                });
              }
              return back("error");
            }
            throw err;
          }
        }
        // Earlier than the current resume day (or a hold without one): come
        // back with the first order on the chosen day. A hold WITHOUT a
        // resume day (paused from the Shopify admin / synced externally) has
        // no current-day clamp above, so bound the chosen day by the pause
        // maximum here (review fix) — a crafted POST must never park an
        // ACTIVE contract with a first order years out.
        if (!currentDay) {
          const maxResume = await maxPauseResumeAt(
            shop.id,
            contract.pausedAt ?? new Date(),
            tz,
          );
          if (chosen.getTime() > maxResume.getTime()) {
            return back("pause_too_far", dayParams(maxResume, null));
          }
        }
        const updated = await resumeContract(shopDomain, contract.id, {
          ...opts,
          billOn: chosen,
        });
        return back("resume_on", dayParams(updated.nextBillingDate ?? chosen, null));
      }

      case "send_tomorrow": {
        // Run-out "already out" branch (P2.7): pull the upcoming order to
        // tomorrow's shop day. An ACCELERATION — never lock-blocked; the
        // service refuses (typed) when the order is already being prepared,
        // when a payment issue owns the cycle, or when the next order is
        // already tomorrow or sooner. The confirmation carries the new day
        // and an Undo token (next_date spec → the previous date), and the
        // service's contract.next_date_changed event makes SMS UNDO work too.
        const before = contract.nextBillingDate;
        // Double-tap: the form carries the date it was rendered against; the
        // contract already moved ⇒ the pull already happened, report it.
        if (isDuplicateCycleSubmit()) {
          return back("send_tomorrow_done", dayParams(before, followingOf(before)));
        }
        try {
          const updated = await sendNextOrderTomorrow(shopDomain, contract.id, opts);
          const next = updated.nextBillingDate ?? null;
          return back("send_tomorrow_done", {
            ...dayParams(next, followingOf(next)),
            ...(before && next && before.getTime() !== next.getTime()
              ? undoParam({
                  kind: "next_date",
                  previousNextBillingDate: before.toISOString(),
                  nextBillingDate: next.toISOString(),
                })
              : {}),
          });
        } catch (err) {
          if (err instanceof SendTomorrowError) {
            switch (err.code) {
              case "PREPARING":
                return back("preparing");
              case "PAYMENT_ISSUE":
                return back("send_tomorrow_payment");
              case "ALREADY_SOON":
                return back("send_tomorrow_soon");
              default:
                return back("error");
            }
          }
          throw err;
        }
      }

      case "delivery_instructions": {
        // Delivery instructions (P2.8): a note for the courier / fulfilment,
        // written to the Shopify contract note + a custom attribute and
        // mirrored locally. The service sanitises and caps the text
        // (settings.portal.deliveryInstructionsMaxChars); an empty submit
        // clears it. Never lock-blocked (delivery detail, like address);
        // ACTIVE or PAUSED (EDITABLE_ONLY above).
        const raw = form.get("instructions");
        const text = typeof raw === "string" ? raw : "";
        // Hard upper bound on the raw body before it reaches the service:
        // the cap is enforced there by character; this only refuses abuse.
        if (text.length > 4000) return back("error");
        const updated = await setDeliveryInstructions(
          shopDomain,
          contract.id,
          text,
          opts,
        );
        return back(
          updated.deliveryInstructions ? "instructions_saved" : "instructions_cleared",
        );
      }

      case "reactivate": {
        // One-tap restart of a CANCELLED subscription — the anti-dead-end.
        // Reuses the win-back reactivation service (activate + bill soon,
        // WinbackState bookkeeping, winback.reactivated event). Offer parity
        // (v1.28.0, P3.5): the incentive is re-derived SERVER-SIDE from the
        // win-back state + events with the same rules and TTLs the emailed
        // legs use (restart.server.ts) — never from the form — so a customer
        // who was emailed a gift / discount gets it from the portal too, and
        // nothing the engine would not honour is ever applied. Contained: a
        // failed derivation is a plain restart (the pre-1.28 behaviour).
        if (contract.status !== "CANCELLED") return back("error");
        // MERGED source (auto-consolidation): its lines live in the primary
        // contract — re-activating it would be a duplicate subscription.
        // The engine refuses too; this keeps the toast a plain error.
        if (contract.cancelReason === "MERGED") return back("error");
        let admin: Awaited<ReturnType<typeof adminClientForShop>> | null = null;
        try {
          admin = await adminClientForShop(shopDomain);
        } catch (err) {
          console.error("[portal] reactivate: admin client unavailable", err);
        }
        await reactivateWithCurrentOffer(contract, { ...opts, admin });
        return back("restarted");
      }

      case "next_date": {
        const parsed = dateSchema.safeParse(form.get("date"));
        if (!parsed.success) return back("error");
        // Noon UTC pins the calendar day; shopDayStartUtc maps it into the
        // shop's timezone (all schedule math goes through dates.server).
        const candidate = shopDayStartUtc(
          new Date(`${parsed.data}T12:00:00Z`),
          tz,
        );
        const min = shopDayStartUtc(addDaysTz(new Date(), 1, tz), tz);
        const max = shopDayStartUtc(
          addDaysTz(new Date(), portalSettings.nextDateMaxDays, tz),
          tz,
        );
        if (
          Number.isNaN(candidate.getTime()) ||
          candidate.getTime() < min.getTime() ||
          candidate.getTime() > max.getTime()
        ) {
          return back("error");
        }
        const before = contract.nextBillingDate;
        const updated = await setNextBillingDate(
          shopDomain,
          contract.id,
          candidate,
          opts,
        );
        const next = updated?.nextBillingDate ?? candidate;
        return back("date_changed", {
          ...dayParams(next, followingOf(next)),
          ...(before && before.getTime() !== next.getTime()
            ? undoParam({
                kind: "next_date",
                previousNextBillingDate: before.toISOString(),
                nextBillingDate: next.toISOString(),
              })
            : {}),
        });
      }

      case "line_skip": {
        // Per-line "not this time" (v1.28.0, P2.5): remove ONE recurring
        // product from the upcoming order only. A REDUCTION: lock-blocked
        // like skip; the merchant switch (portal.perLineCycleEdits) holds
        // against a direct POST. The service refuses to empty the cycle
        // (typed LAST_LINE → whole-order skip copy). Toast Undo = signed
        // line_skip spec → unskipLineThisCycle (never blocked).
        if (!portalSettings.perLineCycleEdits) return back("error");
        const line = ownedLine(str(form, "lineId"));
        if (!line || line.isGift || line.isOneTimeAddon) return back("error");
        if (lock.locked) return lockedBack();
        try {
          const updated = await skipLineThisCycle(
            shopDomain,
            contract.id,
            line.id,
            opts,
          );
          const after = updated.lines.find((l) => l.id === line.id);
          const cycleIndex = after?.skippedCycleIndex ?? null;
          return back("line_skipped", {
            ...dayParams(updated.nextBillingDate ?? contract.nextBillingDate, null),
            ...(cycleIndex != null
              ? undoParam({ kind: "line_skip", lineId: line.id, cycleIndex })
              : {}),
          });
        } catch (err) {
          if (err instanceof CycleLineEditError && err.code === "LAST_LINE") {
            return back("skip_line_last_line");
          }
          throw err;
        }
      }

      case "line_unskip": {
        // Undo of line_skip — an ADDITION / RECOVERY: never lock-blocked.
        // Idempotent in the service (no flag ⇒ no-op).
        if (!portalSettings.perLineCycleEdits) return back("error");
        const line = ownedLine(str(form, "lineId"));
        if (!line || line.isGift || line.isOneTimeAddon) return back("error");
        await unskipLineThisCycle(shopDomain, contract.id, line.id, opts);
        return back("line_unskipped");
      }

      case "line_qty_once": {
        // One-order quantity tweak ("Just this order", P2.5). Lock window
        // blocks only a DECREASE below the plan quantity (a reduction);
        // an increase, or restoring the plan quantity, stays available.
        // `quantity` = the plan quantity clears the override.
        if (!portalSettings.perLineCycleEdits) return back("error");
        const line = ownedLine(str(form, "lineId"));
        const quantity = quantitySchema.safeParse(form.get("quantity"));
        if (!line || line.isGift || line.isOneTimeAddon || !quantity.success) {
          return back("error");
        }
        if (lock.locked && quantity.data < line.quantity) return lockedBack();
        try {
          const updated = await setLineQuantityThisCycle(
            shopDomain,
            contract.id,
            line.id,
            quantity.data,
            opts,
          );
          const after = updated.lines.find((l) => l.id === line.id);
          const override = after?.cycleQuantityOverride ?? null;
          const cycleIndex = after?.cycleQuantityOverrideIndex ?? null;
          // The cycle index the tweak landed on is the one the mirror now
          // carries; when the tweak CLEARED the override the previous flag's
          // index is the only witness (a cleared row has none) — Undo needs
          // an index to re-check against, so fall back to it.
          const specIndex = cycleIndex ?? line.cycleQuantityOverrideIndex ?? null;
          // What Undo restores: the override that was live ON THE SAME cycle
          // the tweak landed on — a flag from an older cycle (stale, not yet
          // cleared) is not a previous value for this cycle (review fix:
          // Undo must never write an override the customer never chose).
          const previousOverride =
            line.cycleQuantityOverrideIndex != null &&
            line.cycleQuantityOverride != null &&
            line.cycleQuantityOverrideIndex === specIndex
              ? line.cycleQuantityOverride
              : null;
          return back(override == null ? "line_qty_restored" : "line_qty_once", {
            qty: String(quantity.data),
            ...dayParams(updated.nextBillingDate ?? contract.nextBillingDate, null),
            ...(specIndex != null && override !== previousOverride
              ? undoParam({
                  kind: "line_qty_once",
                  lineId: line.id,
                  cycleIndex: specIndex,
                  previousOverride,
                  override,
                })
              : {}),
          });
        } catch (err) {
          if (err instanceof CycleLineEditError) return back("error");
          throw err;
        }
      }

      case "undo": {
        // Undo (v1.28.0, P2.2): a normal guarded action — session, CSRF,
        // ownership, rate limit above — plus a signed token bound to THIS
        // shop/contract/customer carrying what to restore. performUndo
        // re-checks the contract against the token's after-state (stale
        // ⇒ nothing moves) and logs portal.undo either way. Recovery-like:
        // never lock-blocked.
        const read = readUndoToken(str(form, "undo_token"), {
          shopId: shop.id,
          contractId: contract.id,
          customerId: contract.customerId,
        });
        if (!read.ok) {
          return back(read.reason === "expired" ? "undo_expired" : "error");
        }
        const outcome = await performUndo(shopDomain, contract, read.spec, {
          source: "CUSTOMER_PORTAL",
          actor: "customer",
          via: "portal",
        });
        if (outcome.kind === "restored") {
          return back("undone", dayParams(outcome.nextBillingDate, null));
        }
        if (outcome.kind === "past") return back("undo_expired");
        return back("undo_stale");
      }

      case "address": {
        const raw: Record<string, string> = {};
        for (const key of Object.keys(addressFormSchema.shape)) {
          const value = form.get(key);
          if (typeof value === "string" && value.trim() !== "") {
            raw[key] = value;
          }
        }
        const parsed = addressFormSchema.safeParse(raw);
        if (!parsed.success) return back("error");
        // Country / region come from the page's own tables (v1.28.0, P2.8
        // review fix): an unknown country or, for countries with a required
        // region list, a region that is not on it is refused with a
        // field-level toast before Shopify ever sees the draft.
        if (!isKnownCountry(parsed.data.countryCode)) return back("error");
        const region = normalizeProvinceCode(
          parsed.data.countryCode,
          parsed.data.provinceCode,
        );
        if (!region.ok) return back("address_region_invalid");
        const address: DeliveryAddressInput = {
          ...parsed.data,
          provinceCode: region.value ?? undefined,
        };
        await updateDeliveryAddress(shopDomain, contract.id, address, opts);
        return back("address_updated");
      }

      case "payment_update": {
        if (contract.status === "CANCELLED" || contract.status === "EXPIRED") {
          return back("error");
        }
        // Funnel measurement (v1.28.0): the click itself, before the path is
        // decided — the resolver logs which channel actually served it.
        await logEvent({
          shopId: shop.id,
          contractId: contract.id,
          customerId: contract.customerId,
          email: contract.email,
          type: "portal.payment_update_clicked",
          source: "CUSTOMER_PORTAL",
          actor: "customer",
          payload: {
            instrumentType: contract.paymentInstrumentType ?? null,
            hasPaymentMethod: contract.paymentMethodId != null,
            revoked: contract.paymentMethodRevokedAt != null,
          },
        });
        if (!contract.paymentMethodId) return back("error");
        const admin = await adminClientForShop(shopDomain);
        // ONE server-side decision (app/lib/payments/cardUpdate.server.ts):
        // Shop Pay → Shopify-hosted secure page (302); cards / PayPal →
        // Shopify emails the customer its own 48h update link. The app never
        // sees card data on either path.
        const path = await resolveCardUpdatePath({
          admin,
          contract,
          source: "CUSTOMER_PORTAL",
          actor: "customer",
        });
        if (path.kind === "redirect") return redirect(path.url);
        if (path.kind === "email_sent") return back("card_link_sent");
        return back("error");
      }

      case "payment_select":
      case "payment_backup": {
        // Payment-methods list (v1.28.0, P1.7 — settings.portal.
        // paymentMethodsList). The form's paymentMethodId is NEVER trusted:
        // the contracts service validates it against
        // listCustomerPaymentMethods for THIS contract's customer
        // (PAYMENT_METHOD_NOT_ON_ACCOUNT otherwise) and Shopify's own draft
        // refuses a foreign method with CUSTOMER_MISMATCH. Refusals map to
        // friendly toasts; the mirror is untouched on any of them.
        if (
          (portalSettings as { paymentMethodsList?: boolean }).paymentMethodsList ===
          false
        ) {
          return back("error");
        }
        const rawId = str(form, "paymentMethodId");
        const clearing = actionName === "payment_backup" && rawId === "";
        if (!clearing && !isPaymentMethodGid(rawId)) return back("error");
        try {
          if (actionName === "payment_select") {
            const previous = contract.paymentMethodId;
            await changePaymentMethod(shopDomain, contract.id, rawId, {
              ...opts,
              trigger: "select",
            });
            invalidatePaymentMethodsCache(contract.customerId);
            await logEvent({
              shopId: shop.id,
              contractId: contract.id,
              customerId: contract.customerId,
              email: contract.email,
              type: "portal.payment_select",
              source: "CUSTOMER_PORTAL",
              actor: "customer",
              payload: {
                paymentMethodId: rawId,
                previousPaymentMethodId: previous,
                noop: previous === rawId,
                status: contract.status,
              },
            });
            return back("payment_method_changed");
          }
          const previousBackup = contract.backupPaymentMethodId;
          await setBackupPaymentMethod(
            shopDomain,
            contract.id,
            clearing ? null : rawId,
            { ...opts, setBy: "CUSTOMER" },
          );
          invalidatePaymentMethodsCache(contract.customerId);
          await logEvent({
            shopId: shop.id,
            contractId: contract.id,
            customerId: contract.customerId,
            email: contract.email,
            type: "portal.payment_backup_set",
            source: "CUSTOMER_PORTAL",
            actor: "customer",
            payload: {
              paymentMethodId: clearing ? null : rawId,
              previousBackupPaymentMethodId: previousBackup,
              cleared: clearing,
            },
          });
          return back(clearing ? "backup_cleared" : "backup_set");
        } catch (err) {
          const toast = paymentMethodErrorToast(err);
          if (toast) {
            console.warn(
              `[portal] ${actionName} refused for contract ${contract.id}: ${toast}`,
            );
            return back(toast);
          }
          throw err;
        }
      }

      case "payment_retry": {
        // Customer "Retry now" (v1.28.0, P1.3). The engine owns every guard
        // (open case or FAILED→reopen, per-case cooldown, paused /
        // challenge-pending refusals, in-flight dedupe) and fires through
        // fireRetry's idempotent path; it also logs portal.payment_retry.
        const outcome = await requestCustomerRetry(contract.id, {
          source: "CUSTOMER_PORTAL",
          actor: "customer",
        });
        switch (outcome.kind) {
          case "started":
            return back("retry_started");
          case "too_soon":
            return back("retry_too_soon");
          case "unavailable":
            if (outcome.reason === "challenge_pending") {
              return back("retry_needs_bank");
            }
            if (outcome.reason === "contract_paused") {
              return back("retry_paused");
            }
            if (outcome.reason === "claim_lost") {
              // A concurrent tap (double-tap / second tab) won the claim: the
              // retry the customer wants IS running — same semantics as the
              // in-flight branch, never "nothing to retry".
              return back("retry_started");
            }
            return back("retry_unavailable");
          case "no_case":
          default:
            return back("retry_unavailable");
        }
      }

      case "payment_skip_and_resume": {
        // "Skip that order and continue from {date}" (v1.28.0, P1.9): the
        // case-aware exit for a FAILED contract — the service resolves the
        // exhausted case, skips the held cycle on Shopify, reactivates and
        // sets the next date; refusals (card hard-dead → update the card;
        // attempt in flight / not failed / no case) are typed and mapped
        // here. It logs portal.payment_skip_resume {outcome} itself.
        const outcome = await skipFailedCycleAndResume(shopDomain, contract.id, {
          ...opts,
        });
        switch (outcome.kind) {
          case "resumed":
            return back("skip_resumed", {
              d1: calendarDayIn(outcome.nextBillingDate, shop.ianaTimezone),
            });
          case "already_active":
            return back("restarted");
          case "refused":
          default:
            if (
              outcome.reason === "card_revoked" ||
              outcome.reason === "card_expired" ||
              outcome.reason === "no_card"
            ) {
              return back("skip_resume_card_dead");
            }
            if (outcome.reason === "attempt_in_flight") {
              return back("retry_started");
            }
            return back("skip_resume_unavailable");
        }
      }

      case "payment_3ds": {
        // "Confirm with my bank" (v1.28.0, P1.6): the CHALLENGED attempt of
        // the contract's case → Shopify's current nextActionUrl (persisted
        // on BillingAttempt.challengeUrl), gated to Shopify hosts, 302. A
        // challenge that settled meanwhile is re-checked and reported
        // truthfully; no challenge → offer the retry instead.
        const view = await loadPortalDunning(contract);
        if (!view) return back("threeds_none");
        let admin = null;
        try {
          admin = await adminClientForShop(shopDomain);
        } catch (err) {
          console.error("[portal] 3DS admin client unavailable", err);
        }
        const result = await resolvePortalThreeDs({
          admin,
          attemptId: view?.challengedAttemptId ?? null,
        });
        await logEvent({
          shopId: shop.id,
          contractId: contract.id,
          customerId: contract.customerId,
          email: contract.email,
          type: "portal.payment_3ds",
          source: "CUSTOMER_PORTAL",
          actor: "customer",
          payload: {
            dunningCaseId: view?.caseId ?? null,
            attemptId: result.kind === "none" ? null : result.attemptId,
            outcome: result.kind,
            ...(result.kind === "settled" ? { settled: result.outcome } : {}),
          },
        });
        if (result.kind === "redirect") return redirect(result.url);
        if (result.kind === "settled") {
          if (result.outcome === "SUCCESS") return back("threeds_paid");
          if (result.outcome === "FAILED") return back("threeds_failed");
          return back("threeds_unavailable");
        }
        if (result.kind === "untrusted") return back("threeds_unavailable");
        return back("threeds_none");
      }

      case "support": {
        // Get-help form (v1.28.0, P5.1). Same guard chain as every verb
        // (signature → session → CSRF → hourly limit → ownership), plus a
        // stricter per-customer budget: settings.support.requestsPerHour
        // support submits per rolling hour, counted on the SAME
        // insert-then-count attempt rows the general limit uses (payload
        // action "support"), so a burst cannot slip past. Any status may ask
        // for help (a CANCELLED subscriber with a delivery problem is still
        // a customer). Every downstream effect is contained inside
        // submitSupportRequest; only a failed event write reaches the catch.
        const supportSettings = await getSetting(shop.id, "support");
        const recentSupport = await prisma.subscriberEvent.count({
          where: {
            shopId: shop.id,
            customerId: portalSession.customerId,
            source: "CUSTOMER_PORTAL",
            type: "portal.mutation_attempt",
            createdAt: { gte: new Date(Date.now() - 3600_000) },
            payload: { path: ["action"], equals: "support" },
          },
        });
        if (recentSupport > supportSettings.requestsPerHour) {
          return liquid(rateLimitedHtml(locale, portalSession.previewToken), 429);
        }
        const topicRaw = str(form, "topic");
        const topic = isSupportTopic(topicRaw) ? topicRaw : null;
        const message = normalizeSupportMessage(form.get("message"));
        if (!topic || !message) return back("error");
        const surfaceRaw = str(form, "surface");
        const surface =
          surfaceRaw === "portal_account" ||
          surfaceRaw === "portal_dunning" ||
          surfaceRaw === "portal_detail"
            ? surfaceRaw
            : "portal_detail";
        const order = await resolveOrderRef(
          contract.id,
          str(form, "order_ref") || null,
          tz,
          locale,
          contract.currencyCode,
        );
        // The push-back IS a delay: it obeys the same refusals the "delay"
        // verb does (ACTIVE only, plan lock window, order being prepared) —
        // refused here means the request still goes through, without it,
        // and the toast says so.
        let pushBack = topic === "DELIVERY" && str(form, "push_back") === "1";
        let pushBackRefused = false;
        // Duplicate-submit guard (same expected_next dedupe as the delay
        // verb): the form carries the cycle date it targeted; if the contract
        // already moved past it (stale tab, JS-off double-click, second tab)
        // the delay was ALREADY applied — record the request without pushing
        // a second week, and do not report a refusal (nothing was refused).
        if (pushBack && isDuplicateCycleSubmit()) {
          pushBack = false;
        }
        if (pushBack) {
          const pushLock = await resolveLockState(shop.id, contract, tz);
          const timing = await resolveChargeTiming(shop.id, tz);
          if (
            contract.status !== "ACTIVE" ||
            pushLock.locked ||
            (await isPreparingOrder(contract, timing))
          ) {
            pushBack = false;
            pushBackRefused = true;
          }
        }
        const result = await submitSupportRequest({
          shopId: shop.id,
          shopDomain,
          contract,
          topic,
          message,
          orderRef: order?.orderRef ?? null,
          orderLabel: order?.orderLabel ?? null,
          pushBack,
          surface,
          source: "CUSTOMER_PORTAL",
          actor: "customer",
        });
        return back(
          result.pushBackFailed || pushBackRefused
            ? "support_pushback_failed"
            : "support_sent",
          { sla: String(result.slaBusinessDays) },
        );
      }

      default:
        throw new Response("Not Found", { status: 404 });
    }
  } catch (err) {
    if (err instanceof Response) throw err;
    // Shopify refused a contract-level edit while one-off (billing-cycle)
    // changes are staged on the upcoming order (v1.28.0 review fix): say
    // exactly that — "undo those first" — instead of a generic failure.
    // Nothing changed on Shopify or the mirror.
    // (Matched by name, not instanceof: the class lives in the contracts
    // service module, and the check must hold for every caller path.)
    if (isContractEditBlocked(err)) return back("cycle_edits_pending");
    console.error(
      `[portal] action "${actionName}" failed for contract ${contract.id}`,
      err,
    );
    // "Nothing happened" vs "applied on Shopify, mirror pending": when the
    // Shopify mutation succeeded but the local mirror write failed,
    // withMirrorGuard has just logged a mirror_divergence event for this
    // contract. Showing a flat error there would tell the customer the change
    // failed when it actually took effect — inviting a retry that compounds
    // the change. Surface a softer "saved, catching up" toast instead.
    try {
      const divergence = await prisma.subscriberEvent.findFirst({
        where: {
          contractId: contract.id,
          type: "contract.updated",
          source: "CUSTOMER_PORTAL",
          createdAt: { gte: new Date(Date.now() - 15_000) },
          payload: { path: ["action"], equals: "mirror_divergence" },
        },
        select: { id: true },
      });
      if (divergence) return back("saved_pending");
    } catch (probeErr) {
      console.error("[portal] divergence probe failed", probeErr);
    }
    return back("error");
  }
};
