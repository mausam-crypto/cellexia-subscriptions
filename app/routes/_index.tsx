import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { login } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  // Nothing to see at the bare root — this app is embedded in Shopify admin.
  // Only GET requests reach Shopify's login() helper: it calls
  // request.formData() for any non-GET method, which throws on bodyless
  // requests like Render's HEAD / health-check probe.
  if (request.method !== "GET") {
    return new Response(null, { status: 200 });
  }
  return await login(request);
};

export default function Index() {
  return null;
}
