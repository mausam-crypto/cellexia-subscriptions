import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { login } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  // Bare infrastructure probes (HEAD, no body/content-type) hit this route
  // with neither a shop param nor a form submission — login() unconditionally
  // tries to read the request as form data and throws for these. Real
  // traffic either carries ?shop= (redirected above) or POSTs the login form.
  if (request.method === "HEAD") {
    return new Response(null, { status: 200 });
  }
  // Nothing to see at the bare root — this app is embedded in Shopify admin.
  return await login(request);
};

export default function Index() {
  return null;
}
