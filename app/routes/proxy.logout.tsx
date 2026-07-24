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
  return redirect(withLocale(`${PORTAL_BASE_PATH}/login`, locale), {
    headers: { "Set-Cookie": clearCookie },
  });
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);
  const locale = localeFromRequest(request);
  throw redirect(withLocale(`${PORTAL_BASE_PATH}/`, locale));
};
