/**
 * Customer portal layout — Cellexia-branded, pure HTML/CSS (no Polaris).
 * Wordmark header, quiet nav, outlet, reassuring footer.
 */
import type {
  LinksFunction,
  LoaderFunctionArgs,
  MetaFunction,
} from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, NavLink, Outlet, useLoaderData } from "@remix-run/react";
import "~/styles/portal.css";
import {
  getPortalCustomer,
  getPortalFontBaseUrl,
  resolveLoginShop,
} from "~/services/portal/auth.server";
import { buildFontFaceCss } from "~/components/portal/logic";

export const links: LinksFunction = () => [];

export const meta: MetaFunction = () => [
  { title: "Cellexia — Continuous Treatment" },
  {
    name: "description",
    content: "Your Cellexia treatment plan. Adjust, delay or cancel online.",
  },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const customer = await getPortalCustomer(request);
  const shop = customer?.shop ?? (await resolveLoginShop(request));
  const fontCss = buildFontFaceCss(await getPortalFontBaseUrl(shop));
  return json({
    authed: Boolean(customer),
    fontCss,
    supportEmail: process.env.PORTAL_SUPPORT_EMAIL || "care@cellexia.com",
  });
}

const NAV = [
  { to: "/portal", label: "Dashboard", end: true },
  { to: "/portal/delivery", label: "Next delivery", end: false },
  { to: "/portal/routine", label: "My routine", end: false },
  { to: "/portal/manage", label: "Settings", end: false },
];

export default function PortalLayout() {
  const { authed, fontCss, supportEmail } = useLoaderData<typeof loader>();
  return (
    <div className="cx-portal">
      {fontCss ? <style dangerouslySetInnerHTML={{ __html: fontCss }} /> : null}
      <header className="cx-header">
        <Link to="/portal" className="cx-wordmark">
          Cellexia
          <span className="cx-subline">Continuous Treatment</span>
        </Link>
        {authed ? (
          <nav className="cx-nav" aria-label="Portal">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `cx-nav__link${isActive ? " is-active" : ""}`
                }
              >
                {item.label}
              </NavLink>
            ))}
            <Link to="/portal/logout" className="cx-nav__link">
              Sign out
            </Link>
          </nav>
        ) : (
          <div style={{ height: 24 }} />
        )}
      </header>
      <main className="cx-main">
        <Outlet />
      </main>
      <footer className="cx-footer">
        <p>
          Questions about your treatment?{" "}
          <a href={`mailto:${supportEmail}`}>We're here to help.</a>
        </p>
        <span className="cx-footer__reassure">
          Adjust, delay or cancel online — whenever you need.
        </span>
      </footer>
    </div>
  );
}
