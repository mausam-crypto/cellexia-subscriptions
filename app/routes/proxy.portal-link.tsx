/**
 * App-proxy entry: how storefront "Manage my treatment" links land in the
 * portal without passwords (mounted at /apps/cellexia-subscriptions/portal-link).
 *
 * - GET while logged into the storefront: Shopify appends a verified
 *   `logged_in_customer_id`; we hand off via a 5-minute single-use token and
 *   302 (absolute URL) to the app-domain portal, where the session cookie is
 *   set. Identity ONLY comes from the HMAC-verified proxy context — never
 *   from bare query params.
 * - GET while logged out: 302 to the portal login page.
 * - POST with an email: request a magic link; always answers success
 *   (no account enumeration).
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import {
  portalBaseUrl,
  proxyHandoff,
  requestMagicLink,
} from "~/services/portal/auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  // Verifies the proxy HMAC; throws for forged requests.
  await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const loggedInCustomerId = url.searchParams.get("logged_in_customer_id");

  if (shop && loggedInCustomerId) {
    return proxyHandoff(shop, loggedInCustomerId);
  }
  const base = portalBaseUrl();
  return redirect(base ? `${base}/portal/login` : "/portal/login", 302);
}

export async function action({ request }: ActionFunctionArgs) {
  await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();

  if (shop && email) {
    await requestMagicLink(shop, email);
  }
  return json({
    ok: true,
    message:
      "If that email has a treatment plan with us, a secure sign-in link is on its way. It stays valid for 30 minutes.",
  });
}
