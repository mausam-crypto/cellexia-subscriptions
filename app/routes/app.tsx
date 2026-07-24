import type { HeadersFunction, LinksFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

import { authenticate } from "~/shopify.server";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: polarisStyles },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return json({ apiKey: process.env.SHOPIFY_API_KEY || "" });
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          Dashboard
        </Link>
        <Link to="/app/preview">Preview &amp; launch</Link>
        <Link to="/app/subscribers">Subscribers</Link>
        <Link to="/app/dunning">Dunning</Link>
        <Link to="/app/analytics">Analytics</Link>
        <Link to="/app/plans">Plans</Link>
        <Link to="/app/buy-box">Buy box designer</Link>
        <Link to="/app/gifts">Gifts</Link>
        <Link to="/app/cancel-flow">Cancel flow</Link>
        <Link to="/app/bulk">Bulk ops</Link>
        <Link to="/app/import">Import</Link>
        <Link to="/app/alerts">Alerts</Link>
        <Link to="/app/audit">Audit</Link>
        <Link to="/app/settings">Settings</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their headers
// are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
