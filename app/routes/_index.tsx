import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { login } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function Index() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "4rem" }}>
      <h1>Cellexia Continuous Treatment</h1>
      <p>
        Subscription lifecycle optimisation for Cellexia. Install this app from
        the Shopify admin, or open it from your store&apos;s Apps section.
      </p>
    </main>
  );
}
