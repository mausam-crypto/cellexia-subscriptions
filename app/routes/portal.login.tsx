/**
 * Magic-link request page. Always shows the same success state so account
 * existence can never be inferred.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Link, useActionData } from "@remix-run/react";
import {
  getPortalCustomer,
  requestMagicLink,
  resolveLoginShop,
} from "~/services/portal/auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const customer = await getPortalCustomer(request);
  if (customer) throw redirect("/portal");
  return json({ ok: true });
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const shop = await resolveLoginShop(request);
  if (shop && email) {
    await requestMagicLink(shop, email);
  }
  // Identical response whether or not the email matched anything.
  return json({ sent: true });
}

export default function PortalLogin() {
  const actionData = useActionData<typeof action>();

  if (actionData?.sent) {
    return (
      <div className="cx-auth-wrap">
        <div className="cx-card cx-card--accent cx-card--center">
          <span className="cx-eyebrow">Check your inbox</span>
          <h1 className="cx-headline">Your link is on its way</h1>
          <p className="cx-lead">
            If that email has a treatment plan with us, a secure sign-in link
            is on its way. It stays valid for 30 minutes.
          </p>
          <p className="cx-note">
            Nothing arriving? Check your spam folder, or request a fresh link.
          </p>
          <hr className="cx-divider" />
          <Link to="/portal/login" className="cx-link-quiet">
            Use a different email
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="cx-auth-wrap">
      <div className="cx-card cx-card--accent">
        <span className="cx-eyebrow">Your treatment space</span>
        <h1 className="cx-headline">Welcome back</h1>
        <p className="cx-lead">
          Enter the email you used for your treatment plan. We'll email you a
          secure link — no password needed.
        </p>
        <form method="post">
          <div className="cx-field">
            <label className="cx-field__label" htmlFor="portal-email">
              Email address
            </label>
            <input
              id="portal-email"
              className="cx-input"
              type="email"
              name="email"
              autoComplete="email"
              required
              placeholder="you@example.com"
            />
          </div>
          <button type="submit" className="cx-btn cx-btn--primary cx-btn--block">
            Email me my secure link
          </button>
        </form>
        <p className="cx-note">
          Adjust, delay or cancel online — your plan is always in your hands.
        </p>
      </div>
    </div>
  );
}
