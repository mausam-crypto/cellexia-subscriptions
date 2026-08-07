import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

/**
 * Bare root. This app is custom-distribution (single merchant) and embedded in
 * the Shopify admin, so there is no login form to render here.
 *
 * Deliberately NEVER calls shopify.server's login() helper: login() reads the
 * request body, which throws on the bodyless HEAD / probes that hosting
 * health checks (Render, load balancers) send — turning every probe into a
 * 500. The loader below touches only the URL, so HEAD and GET both return
 * cleanly. Real health monitoring belongs on /api/health.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return new Response("Cellexia Subscriptions", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
