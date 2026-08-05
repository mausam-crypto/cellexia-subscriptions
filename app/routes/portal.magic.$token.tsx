/**
 * Magic-link verification.
 *
 * GET only *peeks* at the token (no mutation): email security scanners
 * (Defender SafeLinks, Mimecast, Barracuda, …) prefetch every URL in an email
 * with a GET, and consuming the single-use token there would lock out every
 * customer behind such a filter. The atomic claim happens on the explicit
 * POST below — scanners follow links but do not submit forms.
 *
 * Success → session cookie + redirect to /portal.
 * Invalid / expired / used → friendly retry screen (links live 30 minutes).
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData } from "@remix-run/react";
import {
  MagicLinkError,
  isSameOriginClaim,
  peekMagicLink,
  portalBaseUrl,
  verifyMagicLinkAndCreateSession,
} from "~/services/portal/auth.server";

export async function loader({ params }: LoaderFunctionArgs) {
  return json({ reason: await peekMagicLink(params.token ?? "") });
}

/** The origin the claim POST must come from: PORTAL_BASE_URL (the origin the
 * link was minted on), falling back to the request's own origin. */
function expectedClaimOrigin(request: Request): string {
  const base = portalBaseUrl();
  if (base) {
    try {
      return new URL(base).origin;
    } catch {
      // Malformed PORTAL_BASE_URL — fall through to the request origin.
    }
  }
  return new URL(request.url).origin;
}

export async function action({ request, params }: ActionFunctionArgs) {
  // Login-CSRF guard: reject cross-site POSTs so no other site can force this
  // browser to consume a magic token it never asked for (see
  // isSameOriginClaim). GETs stay a pure peek, so email scanners are unharmed.
  if (
    !isSameOriginClaim(
      request.headers.get("Origin"),
      request.headers.get("Sec-Fetch-Site"),
      expectedClaimOrigin(request),
    )
  ) {
    return json({ reason: "INVALID" as const }, { status: 403 });
  }
  const token = params.token ?? "";
  let success: Response;
  try {
    success = await verifyMagicLinkAndCreateSession(request, token);
  } catch (error) {
    if (error instanceof MagicLinkError) {
      return json({ reason: error.reason });
    }
    throw error;
  }
  // Thrown responses short-circuit with the Set-Cookie redirect and keep the
  // action's data type narrow for the failure UI below.
  throw success;
}

const COPY: Record<string, { title: string; body: string }> = {
  EXPIRED: {
    title: "This link has expired",
    body: "Secure links stay valid for 30 minutes. Request a fresh one below — it only takes a moment.",
  },
  USED: {
    title: "This link was already used",
    body: "Each secure link works exactly once. Request a fresh one below and you'll be right back in.",
  },
  INVALID: {
    title: "This link isn't quite right",
    body: "It may have been trimmed by your email app. Request a fresh one below — it only takes a moment.",
  },
};

export default function PortalMagic() {
  const { reason } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const failure = actionData?.reason ?? reason;

  if (!failure) {
    return (
      <div className="cx-auth-wrap">
        <div className="cx-card cx-card--accent cx-card--center">
          <span className="cx-eyebrow">Secure sign-in</span>
          <h1 className="cx-headline">You're verified</h1>
          <p className="cx-lead">
            One tap to confirm it's really you, and you're in.
          </p>
          <Form method="post">
            <button
              type="submit"
              className="cx-btn cx-btn--primary cx-btn--block"
            >
              Continue to my treatment space
            </button>
          </Form>
        </div>
      </div>
    );
  }

  const copy = COPY[failure] ?? COPY.INVALID;
  return (
    <div className="cx-auth-wrap">
      <div className="cx-card cx-card--accent cx-card--center">
        <span className="cx-eyebrow">Secure sign-in</span>
        <h1 className="cx-headline">{copy.title}</h1>
        <p className="cx-lead">{copy.body}</p>
        <Link to="/portal/login" className="cx-btn cx-btn--primary cx-btn--block">
          Request a fresh link
        </Link>
      </div>
    </div>
  );
}
