import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { z } from "zod";
import prisma from "~/db.server";
import { authenticate, adminClientForShop } from "~/shopify.server";
import { requireShop } from "~/lib/shop/install.server";
import { getSetting } from "~/lib/settings/settings.server";
import { t } from "~/lib/i18n/i18n.server";
import { addDaysTz, shopDayStartUtc } from "~/lib/dates.server";
import { getPaymentMethodUpdateUrl } from "~/lib/graphql/index.server";
import {
  addLine,
  addOneTimeAddon,
  changeFrequency,
  changeLineQuantity,
  delayNextCycle,
  pauseContract,
  removeLine,
  resumeContract,
  setNextBillingDate,
  skipNextCycle,
  swapLineVariant,
  unskipNextCycle,
  updateDeliveryAddress,
} from "~/lib/contracts/service.server";
import type { DeliveryAddressInput } from "~/lib/graphql/index.server";
import { reactivateFromWinback } from "~/lib/winback/engine.server";
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
  parseFrequencyToken,
  sameFrequency,
  type Frequency,
} from "~/lib/frequency";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";
import { resolveLockState, type LockState } from "~/lib/contracts/lock.server";

/**
 * Single POST dispatcher for every portal mutation:
 *   /apps/cellexia-subs/api/{skip|unskip|delay|frequency|swap|quantity|add_line|
 *                       remove_line|addon|pause|resume|reactivate|next_date|
 *                       address|payment_update}
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

const addressFormSchema = z.object({
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  company: z.string().trim().max(100).optional(),
  address1: z.string().trim().min(1).max(200),
  address2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(100),
  provinceCode: z.string().trim().max(3).optional(),
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
  return /^\/(subscription\/[A-Za-z0-9_-]+)?$/.test(raw) ? raw : "/";
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
  if (actionName === "resume" && contract.status === "ACTIVE") {
    return back("resumed");
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
  ]);
  if (ACTIVE_ONLY.has(actionName) && contract.status !== "ACTIVE") {
    return back("error");
  }

  // Editable-only actions mirror the detail loader's `editable` rule
  // (ACTIVE || PAUSED). Without this, a crafted POST could update the
  // delivery address of a CANCELLED/EXPIRED contract — a write the portal UI
  // never offers and the rest of the app does not expect on dead contracts.
  const EDITABLE_ONLY = new Set(["address"]);
  if (
    EDITABLE_ONLY.has(actionName) &&
    contract.status !== "ACTIVE" &&
    contract.status !== "PAUSED"
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
  ]);
  let lock: LockState = { locked: false, until: null, lockDays: 0 };
  if (
    LOCK_BLOCKED.has(actionName) ||
    actionName === "quantity" ||
    actionName === "remove_line"
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
        await delayNextCycle(shopDomain, contract.id, { weeks: weeks.data }, opts);
        return back("delayed");
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
        await changeFrequency(shopDomain, contract.id, freq, opts);
        return back("frequency_changed");
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
        await resumeContract(shopDomain, contract.id, opts);
        return back("resumed");
      }

      case "reactivate": {
        // One-tap restart of a CANCELLED subscription — the anti-dead-end.
        // Reuses the win-back reactivation service (activate + bill soon,
        // WinbackState bookkeeping, winback.reactivated event). No discount
        // is granted from here: percent 0 means any incentive comes only from
        // a win-back grant that already exists.
        if (contract.status !== "CANCELLED") return back("error");
        await reactivateFromWinback(contract.id, {}, opts);
        return back("restarted");
      }

      case "next_date": {
        const parsed = dateSchema.safeParse(form.get("date"));
        if (!parsed.success) return back("error");
        const tz = shop.ianaTimezone;
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
        await setNextBillingDate(shopDomain, contract.id, candidate, opts);
        return back("date_changed");
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
        const address: DeliveryAddressInput = parsed.data;
        await updateDeliveryAddress(shopDomain, contract.id, address, opts);
        return back("address_updated");
      }

      case "payment_update": {
        if (contract.status === "CANCELLED" || contract.status === "EXPIRED") {
          return back("error");
        }
        if (!contract.paymentMethodId) return back("error");
        const admin = await adminClientForShop(shopDomain);
        const url = await getPaymentMethodUpdateUrl(
          admin,
          contract.paymentMethodId,
        );
        // Shopify-hosted secure card page — the app never sees card data.
        return redirect(url);
      }

      default:
        throw new Response("Not Found", { status: 404 });
    }
  } catch (err) {
    if (err instanceof Response) throw err;
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
