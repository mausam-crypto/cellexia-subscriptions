import type { Shop } from "@prisma/client";
import { redirect } from "@remix-run/node";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { requireShop } from "~/lib/shop/install.server";
import {
  localeFromRequest,
  portalPage,
  resolveToast,
  setupGatePage,
  withLocale,
  type PortalToast,
} from "~/lib/portal/layout.server";
import { isSetupMode } from "~/lib/launch/launch.server";
import {
  PORTAL_BASE_PATH,
  requireCustomer,
  verifyCsrf,
  type PortalSessionContext,
} from "~/lib/portal/session.server";
import type { LocalContractWithLines } from "~/lib/contracts/shared.server";

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
    throw (liquid as unknown as LiquidFn)(setupGatePage(locale), {
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
    contract.customerId !== portalSession.customerId
  ) {
    throw new Response("Not found", { status: 404 });
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
    }),
  );
}
