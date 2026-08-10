import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { localeFromRequest, withLocale } from "~/lib/portal/layout.server";
import { PORTAL_BASE_PATH, destroySession } from "~/lib/portal/session.server";

/**
 * Sign out: POST-only (the account page renders the form), deletes the
 * PortalSession row and clears the cookie. A stray GET just goes home.
 */

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.public.appProxy(request);
  const locale = localeFromRequest(request);
  const clearCookie = await destroySession(request);
  // Storefront-login identity: Shopify appends ?logged_in_customer_id= to
  // every proxied request while the customer is signed into their store
  // account, so bouncing to our /login would just re-open the session —
  // there is no app credential left to destroy. Hand off to Shopify's own
  // logout instead (the store account IS the session). The account page
  // already links there directly (see viaStorefrontLogin); this catches a
  // stale/cached form that still POSTs here.
  if (new URL(request.url).searchParams.get("logged_in_customer_id")) {
    return redirect("/account/logout", {
      headers: { "Set-Cookie": clearCookie },
    });
  }
  return redirect(withLocale(`${PORTAL_BASE_PATH}/login`, locale), {
    headers: { "Set-Cookie": clearCookie },
  });
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);
  const locale = localeFromRequest(request);
  // A stray GET during an admin preview keeps its cx_pp token: the proxy
  // strips cookies, so the token in the URL is the whole session. (The POST
  // above deliberately drops it — signing out of a preview should end it.)
  const preview = new URL(request.url).searchParams.get("cx_pp");
  throw redirect(withLocale(`${PORTAL_BASE_PATH}/`, locale, preview));
};
