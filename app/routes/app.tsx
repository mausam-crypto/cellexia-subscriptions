import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";

// Polaris CSS is a side-effect import, not `...styles.css?url` + a `links`
// export. Remix's Vite plugin puts a route's imported CSS in the route
// manifest (`css: [...]`), and `<Links />` in `app/root.tsx` renders it, so
// the stylesheet is still linked only on `/app/*` — same result as before.
// `?url` is deliberately avoided: Vite encodes those ids into a
// `__VITE_CSS_URL__<hex>__` marker that it hex-decodes in `renderChunk`, and
// `Buffer.from(str, "hex")` silently returns an empty buffer for two-byte
// (non-Latin1) strings on Node 23.2.x. Any non-ASCII character anywhere in the
// admin bundle makes the chunk a two-byte string and the build then dies with
// `[vite:css-post] css content for "" was not found`. Keep CSS imports plain.
import "@shopify/polaris/build/esm/styles.css";

import { authenticate } from "~/shopify.server";

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
        <Link to="/app/emails">Emails</Link>
        <Link to="/app/analytics">Analytics</Link>
        <Link to="/app/plans">Plans</Link>
        <Link to="/app/buy-box">Buy box designer</Link>
        <Link to="/app/gifts">Gifts</Link>
        <Link to="/app/experiments">Experiments</Link>
        <Link to="/app/cancel-flow">Cancel flow</Link>
        <Link to="/app/bulk">Bulk ops</Link>
        <Link to="/app/import">Import</Link>
        <Link to="/app/alerts">Alerts</Link>
        <Link to="/app/audit">Audit</Link>
        <Link to="/app/debug">Debug</Link>
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
