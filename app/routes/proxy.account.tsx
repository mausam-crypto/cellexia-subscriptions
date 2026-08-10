import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { requireShop } from "~/lib/shop/install.server";
import { t } from "~/lib/i18n/i18n.server";
import { formatShopDate } from "~/lib/dates.server";
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
  requireCustomer,
} from "~/lib/portal/session.server";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";

/**
 * Account tab: who is signed in, when they joined, shortcuts to each
 * subscription's settings, and sign-out. Deliberately light — the heavy
 * management UI lives on the subscription page.
 */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { liquid, session } = await authenticate.public.appProxy(request);
  if (!session) throw new Response("Unauthorized", { status: 401 });
  const locale = localeFromRequest(request);
  const portalSession = await requireCustomer(request);
  const shop = await requireShop(session.shop);

  // Launch gate: while in setup mode the portal is closed to the public —
  // only admin preview sessions pass through.
  if (!portalSession.isPreview && (await isSetupMode(shop.id))) {
    return liquid(closedPortalPage(request, locale), {
      headers: { "X-Robots-Tag": "noindex" },
    });
  }

  const contracts = await prisma.subscriptionContract.findMany({
    // OURS_ONLY: contracts from the store's other subscription app are neither
    // listed nor counted here — "member since" must not date from theirs.
    where: {
      shopId: shop.id,
      customerId: portalSession.customerId,
      ...OURS_ONLY,
    },
    include: { lines: { select: { title: true } } },
    orderBy: { createdAt: "desc" },
  });

  const memberSince = contracts.length
    ? new Date(
        Math.min(
          ...contracts.map((c) => (c.firstChargeAt ?? c.createdAt).getTime()),
        ),
      )
    : null;

  const subscriptionLinks = contracts
    .map((c) => {
      const label =
        c.lines.map((l) => l.title).join(", ") ||
        t(locale, "portal.account.subscription_fallback");
      const status = t(locale, `portal.status.${c.status.toLowerCase()}`);
      return `<a class="cxs-item" style="text-decoration:none;color:inherit" href="${withLocale(`${PORTAL_BASE_PATH}/subscription/${c.id}`, locale, portalSession.previewToken)}"><div class="cxs-item__body"><p class="cxs-item__title">${escapeHtml(label)}</p><p class="cxs-item__meta">${escapeHtml(status)}</p></div><span class="cxs-muted">&rsaquo;</span></a>`;
    })
    .join("");

  // Sign-out control. A storefront-login session (logged_in_customer_id) has
  // no app credential to destroy — Shopify re-appends the identity to every
  // proxied request, so POSTing our /logout would silently sign the customer
  // straight back in (see viaStorefrontLogin). For those sessions the only
  // honest sign-out is Shopify's own /account/logout; cookie and preview
  // sessions keep the app's POST /logout.
  const signOutHtml = portalSession.viaStorefrontLogin
    ? `<a class="cxs-btn cxs-btn--quiet cxs-btn--full" href="/account/logout">${escapeHtml(t(locale, "portal.account.sign_out"))}</a>`
    : `<form method="post" action="${withLocale(`${PORTAL_BASE_PATH}/logout`, locale)}">
    <button type="submit" class="cxs-btn cxs-btn--quiet cxs-btn--full">${escapeHtml(t(locale, "portal.account.sign_out"))}</button>
  </form>`;

  const body = `
<div class="cxs-card">
  <span class="cxs-label">${escapeHtml(t(locale, "portal.account.signed_in_as"))}</span>
  <p style="margin:0;font-weight:500">${escapeHtml(portalSession.email)}</p>
  ${
    memberSince
      ? `<p class="cxs-muted cxs-small" style="margin:6px 0 0">${escapeHtml(
          t(locale, "portal.account.member_since", {
            date: formatShopDate(memberSince, shop.ianaTimezone, locale),
          }),
        )}</p>`
      : ""
  }
</div>
${
  subscriptionLinks
    ? `<div class="cxs-card"><span class="cxs-label">${escapeHtml(t(locale, "portal.account.your_subscriptions"))}</span>${subscriptionLinks}</div>`
    : ""
}
<div class="cxs-card">
  <p class="cxs-muted cxs-small" style="margin:0 0 14px">${escapeHtml(t(locale, "portal.account.help"))}</p>
  ${signOutHtml}
</div>`;

  return liquid(
    portalPage({
      locale,
      title: t(locale, "portal.account.title"),
      body,
      activeNav: "account",
      isPreview: portalSession.isPreview,
      previewToken: portalSession.previewToken,
    }),
  );
};
