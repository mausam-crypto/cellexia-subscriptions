import type { Shop } from "@prisma/client";
import { redirect } from "@remix-run/node";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { requireShop } from "~/lib/shop/install.server";
import {
  localeFromRequest,
  portalPage,
  resolveToast,
  closedPortalPage,
  withLocale,
  type PortalToast,
} from "~/lib/portal/layout.server";
import { isSetupMode } from "~/lib/launch/launch.server";
import { isBillableOwnership } from "~/lib/ownership/ownership.server";
import {
  PORTAL_BASE_PATH,
  requireCustomer,
  verifyCsrf,
  type PortalSessionContext,
} from "~/lib/portal/session.server";
import type { LocalContractWithLines } from "~/lib/contracts/shared.server";
import { resolveLockState, type LockState } from "~/lib/contracts/lock.server";

/**
 * Bridge between the cancel flow and the portal module: app-proxy signature
 * verification, customer authentication (requireCustomer), contract-ownership
 * guarding, CSRF verification and the shared portal page layout. Follows the
 * exact loader pattern of the other proxy.* portal routes.
 */

/** Shape of `liquid` returned by authenticate.public.appProxy — a Response
 * with Content-Type application/liquid so the theme wraps the fragment. */
export type LiquidFn = (body: string, init?: ResponseInit) => Response;

export interface CancelRouteContext {
  shop: Shop;
  contract: LocalContractWithLines;
  portalSession: PortalSessionContext;
  locale: string;
  liquid: LiquidFn;
  /** Resolved ?toast= for preview sessions (mutation-blocked feedback). */
  previewToast: PortalToast | null;
  /**
   * Plan lock window state (v1.28.0, P3.8). `locked` is only ever true here
   * when cancelFlow.scheduledCancelEnabled let a locked contract into the
   * flow — the routes then run the SCHEDULED variant (no reducing saves, the
   * confirm step schedules the cancel for `until`) instead of cancelling
   * today. Preview sessions resolve it too (the admin walks the real UI).
   */
  lock: LockState;
}

/**
 * Verify the proxy signature, authenticate the portal customer and load the
 * contract with an ownership guard. 404 (not 403) when the contract does not
 * exist or belongs to another customer, so ids cannot be probed through the
 * proxy.
 */
export async function requireCancelContext(
  request: Request,
  contractParam: string | undefined,
): Promise<CancelRouteContext> {
  const { liquid, session } = await authenticate.public.appProxy(request);
  if (!session) throw new Response("Unauthorized", { status: 401 });
  const locale = localeFromRequest(request);

  // Throws a redirect to the portal login when no valid session cookie.
  const portalSession = await requireCustomer(request);

  const shop = await requireShop(session.shop);
  if (portalSession.shopId !== shop.id) {
    throw redirect(withLocale(`${PORTAL_BASE_PATH}/login`, locale));
  }

  // Launch gate: while the app is in setup mode the portal is closed to the
  // public — only admin preview sessions pass through.
  if (!portalSession.isPreview && (await isSetupMode(shop.id))) {
    throw (liquid as unknown as LiquidFn)(closedPortalPage(request, locale), {
      headers: { "X-Robots-Tag": "noindex" },
    });
  }

  if (!contractParam) throw new Response("Not found", { status: 404 });
  const contract = await prisma.subscriptionContract.findUnique({
    where: { id: contractParam },
    include: { lines: true },
  });
  if (
    !contract ||
    contract.shopId !== shop.id ||
    contract.customerId !== portalSession.customerId ||
    // The cancel-save flow is a portal action like any other: a contract owned
    // by the store's other subscription app is not ours to cancel or to make
    // retention offers on.
    !isBillableOwnership(contract.ownership)
  ) {
    throw new Response("Not found", { status: 404 });
  }

  // ── Plan lock window: the whole cancel flow is one choke point ─────────────
  // This context guards EVERY loader and action of both cancel routes, so a
  // locked contract can neither browse the flow nor land a crafted POST on
  // /cancel/:id/confirm (which would otherwise mint its own session and
  // cancel). Redirect to the subscription page, whose lock notice shows the
  // unlock date. Admin previews pass — they are read-only everywhere anyway
  // and the merchant must be able to inspect the flow.
  //
  // Scheduled cancel (v1.28.0, P3.8): when cancelFlow.scheduledCancelEnabled
  // (default ON) a locked contract is let INTO the flow instead — the
  // routes hide every reducing save (LOCK_BLOCKED_SAVES, enforced by the
  // engine too) and the confirm step schedules the cancellation for the
  // unlock moment. Cancel stays reachable, honestly: "cancels on {date}".
  const lock = await resolveLockState(shop.id, contract, shop.ianaTimezone);
  if (!portalSession.isPreview) {
    let scheduledCancelEnabled = true;
    // A contract that ALREADY carries a scheduled cancel must always reach
    // its "cancels on {date} · keep" page (and the Keep POST), whatever the
    // toggle says now — the routes redirect it there. Turning the toggle
    // off after schedules exist must never strand a customer while the
    // hourly job still executes the schedule.
    if (lock.locked && !contract.cancelScheduledAt) {
      try {
        const { getSetting } = await import("~/lib/settings/settings.server");
        scheduledCancelEnabled =
          (await getSetting(shop.id, "cancelFlow") as { scheduledCancelEnabled?: boolean })
            .scheduledCancelEnabled !== false;
      } catch {
        // Contained: a broken read keeps the classic redirect (enforcement).
        scheduledCancelEnabled = false;
      }
    }
    if (lock.locked && !scheduledCancelEnabled) {
      // Friendly variant (v1.19.0): carry the unlock day + countdown so the
      // toast explains WHEN instead of a bare refusal — same param contract
      // as the api dispatcher's lockedBack (resolveToast validates them).
      let params = "toast=locked";
      if (lock.until) {
        // Failure-contained like every other v1.19.0 surface: a broken
        // settings read degrades to the classic plain toast — the redirect
        // itself (the enforcement) must never be lost to a copy decision.
        let friendly = false;
        try {
          const { getSetting } = await import(
            "~/lib/settings/settings.server"
          );
          friendly = (await getSetting(shop.id, "portal"))
            .friendlyLockMessaging;
        } catch {
          friendly = false;
        }
        if (friendly) {
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
          params = new URLSearchParams({
            toast: "locked",
            locked_until: label,
            locked_days: String(daysToGo),
          }).toString();
        }
      }
      throw redirect(
        withLocale(
          `${PORTAL_BASE_PATH}/subscription/${contract.id}?${params}`,
          locale,
        ),
      );
    }
  }

  return {
    shop,
    contract,
    portalSession,
    locale,
    // Structural narrowing of Shopify's LiquidResponseFunction (its init
    // param also accepts a bare status number, which we never pass).
    liquid: liquid as unknown as LiquidFn,
    previewToast: portalSession.isPreview
      ? (resolveToast(request, locale)?.toast ?? null)
      : null,
    lock,
  };
}

/** Timing-safe CSRF check of the `_csrf` form field against the session. */
export function csrfOk(ctx: CancelRouteContext, form: FormData): boolean {
  const submitted = form.get("_csrf");
  return verifyCsrf(
    ctx.portalSession,
    typeof submitted === "string" ? submitted : null,
  );
}

export interface PageContent {
  /** Page heading — rendered (escaped) by the portal layout. */
  title: string;
  /** Pre-built, already-escaped HTML for the page content. */
  body: string;
}

/** Wrap step content in the shared portal layout and liquid response. */
export function renderCancelPage(
  ctx: CancelRouteContext,
  content: PageContent,
  opts?: { backHref?: string; backLabel?: string },
): Response {
  return ctx.liquid(
    portalPage({
      locale: ctx.locale,
      title: content.title,
      body: content.body,
      activeNav: "subscriptions",
      backHref: opts?.backHref,
      backLabel: opts?.backLabel,
      toast: ctx.previewToast,
      isPreview: ctx.portalSession.isPreview,
      previewToken: ctx.portalSession.previewToken,
    }),
  );
}
