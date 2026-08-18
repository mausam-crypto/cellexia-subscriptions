import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import prisma from "~/db.server";
import { authenticate, adminClientForShop } from "~/shopify.server";
import { requireShop } from "~/lib/shop/install.server";
import { getSetting } from "~/lib/settings/settings.server";
import { isSetupMode } from "~/lib/launch/launch.server";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";
import {
  closedPortalPage,
  localeFromRequest,
  portalPage,
  resolveToast,
  withLocale,
} from "~/lib/portal/layout.server";
import { PORTAL_BASE_PATH, requireCustomer } from "~/lib/portal/session.server";
import { buildRetentionSummary } from "~/lib/cancel/summary.server";
import { deriveCurrentWinbackOffer } from "~/lib/winback/restart.server";
import { addDaysTz } from "~/lib/dates.server";
import { welcomeBackHtml } from "~/lib/winback/welcome-back.server";
import { t } from "~/lib/i18n/i18n.server";

/**
 * Welcome-back landing (v1.28.0, P3.5) — /apps/cellexia-subs/subscription/:id/restart
 *
 * Reached from the CANCELLED card's Restart button (home + detail). Lists,
 * from real data, what a restart preserves (the routine, the member price
 * when grandfathered, milestone progress — kept, since ordersCount survives
 * a cancel — unlocked rewards, gifts received) and the win-back offer the
 * engine CURRENTLY stands behind (re-derived server-side by the same rules
 * and TTLs the emailed legs use — never an offer the tap will not honour),
 * then ONE button: "Restart my subscription" → POST /api/reactivate, which
 * re-derives and applies the same offer and lands on the detail page with
 * the `restarted` toast. Resource route (theme-wrapped liquid HTML).
 *
 * Honesty: no dark pattern — the page states the first-bill day, that the
 * customer can pause or cancel again at any time, and offers a plain "back"
 * link. Not CANCELLED → straight to the detail page.
 */

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { liquid, session } = await authenticate.public.appProxy(request);
  if (!session) throw new Response("Unauthorized", { status: 401 });
  const locale = localeFromRequest(request);
  const portalSession = await requireCustomer(request);
  const shop = await requireShop(session.shop);

  if (!portalSession.isPreview && (await isSetupMode(shop.id))) {
    return liquid(closedPortalPage(request, locale), {
      headers: { "X-Robots-Tag": "noindex" },
    });
  }

  const contract = await prisma.subscriptionContract.findFirst({
    where: {
      id: params.id ?? "",
      shopId: shop.id,
      customerId: portalSession.customerId,
      ...OURS_ONLY,
    },
    include: { lines: true },
  });
  if (!contract) {
    throw redirect(
      withLocale(`${PORTAL_BASE_PATH}/?toast=not_found`, locale, portalSession.previewToken),
    );
  }
  const detailPath = withLocale(
    `${PORTAL_BASE_PATH}/subscription/${contract.id}`,
    locale,
    portalSession.previewToken,
  );
  if (contract.status !== "CANCELLED") throw redirect(detailPath);
  // A MERGED source (auto-consolidation, consolidation.server.ts) is not
  // restartable: its lines already live in the primary contract, so
  // re-activating it would bill the same products twice. Same refusal as
  // the win-back engine / restart-link minting; the detail page explains.
  if (contract.cancelReason === "MERGED") throw redirect(detailPath);

  const [summary, winback] = await Promise.all([
    buildRetentionSummary(shop, contract),
    getSetting(shop.id, "winback"),
  ]);

  // Offer + gift truth gate need the admin client when it can be built.
  let admin: Awaited<ReturnType<typeof adminClientForShop>> | null = null;
  try {
    admin = await adminClientForShop(session.shop);
  } catch (err) {
    console.error("[portal] welcome-back: admin client unavailable", err);
  }
  const offer = await deriveCurrentWinbackOffer(contract, {
    admin,
    settings: winback,
  });

  const firstBillAt = addDaysTz(
    new Date(),
    winback.reactivationBillDelayDays,
    shop.ianaTimezone,
  );

  const body = welcomeBackHtml({
    locale,
    tz: shop.ianaTimezone,
    contract,
    summary,
    offer,
    firstBillAt,
    csrf: portalSession.csrfToken,
    apiUrl: withLocale(`${PORTAL_BASE_PATH}/api/reactivate`, locale, portalSession.previewToken),
    returnTo: `/subscription/${contract.id}`,
    backHref: detailPath,
  });

  const resolvedToast = resolveToast(request, locale);
  return liquid(
    portalPage({
      locale,
      title: t(locale, "portal.welcome_back.title"),
      body,
      activeNav: "subscriptions",
      toast: resolvedToast?.toast ?? null,
      backHref: detailPath,
      backLabel: t(locale, "portal.welcome_back.back"),
      isPreview: portalSession.isPreview,
      previewToken: portalSession.previewToken,
    }),
  );
};

