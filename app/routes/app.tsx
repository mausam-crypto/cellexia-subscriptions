import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { AppProvider as PolarisAppProvider, Badge } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import "@shopify/polaris/build/esm/styles.css";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    demoMode: process.env.DEMO_MODE === "1",
  };
};

const NAV_LINKS = [
  { to: "/app", label: "Dashboard" },
  { to: "/app/subscribers", label: "Subscribers" },
  { to: "/app/plans", label: "Treatment plans" },
  { to: "/app/widgets", label: "Widgets & offers" },
  { to: "/app/retention", label: "Retention" },
  { to: "/app/dunning", label: "Payment recovery" },
  { to: "/app/treatment", label: "Treatment engine" },
  { to: "/app/analytics", label: "Analytics" },
  { to: "/app/settings", label: "Settings" },
] as const;

function DemoNav() {
  return (
    <nav
      aria-label="Demo navigation"
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "0.25rem 1rem",
        padding: "0.5rem 1rem",
        borderBottom: "1px solid var(--p-color-border, #d8d8d8)",
        background: "var(--p-color-bg-surface, #ffffff)",
        fontSize: "0.8125rem",
      }}
    >
      {NAV_LINKS.map((link) => (
        <Link
          key={link.to}
          to={link.to}
          style={{
            color: "var(--p-color-text, #1d1d1b)",
            textDecoration: "none",
          }}
        >
          {link.label}
        </Link>
      ))}
      <span style={{ marginLeft: "auto" }}>
        <Badge tone="attention">DEMO MODE — Shopify actions disabled</Badge>
      </span>
    </nav>
  );
}

export default function App() {
  const { apiKey, demoMode } = useLoaderData<typeof loader>();

  if (demoMode) {
    // Local preview without a Shopify store: App Bridge requires an embedded
    // admin iframe, so render a plain Polaris shell with a slim nav instead.
    return (
      <PolarisAppProvider i18n={en}>
        <DemoNav />
        <Outlet />
      </PolarisAppProvider>
    );
  }

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          Dashboard
        </Link>
        <Link to="/app/subscribers">Subscribers</Link>
        <Link to="/app/plans">Treatment plans</Link>
        <Link to="/app/widgets">Widgets &amp; offers</Link>
        <Link to="/app/retention">Retention</Link>
        <Link to="/app/dunning">Payment recovery</Link>
        <Link to="/app/treatment">Treatment engine</Link>
        <Link to="/app/analytics">Analytics</Link>
        <Link to="/app/settings">Settings</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
