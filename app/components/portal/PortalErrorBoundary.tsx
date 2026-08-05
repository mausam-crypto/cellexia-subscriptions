/**
 * Branded portal error boundary — the styled backstop every portal route
 * exports so a thrown Response or unexpected error renders as a calm,
 * Cellexia-voiced screen inside the portal layout instead of Remix's raw
 * error page. Never exposes stack traces or internals to customers.
 */
import { Link, isRouteErrorResponse, useRouteError } from "@remix-run/react";

export function PortalErrorBoundary() {
  const error = useRouteError();

  // Expected HTTP errors (404 ownership misses, 400 bad requests) get a
  // gentler headline than genuine crashes; both stay warm and actionable.
  const notFound = isRouteErrorResponse(error) && error.status === 404;

  return (
    <div className="cx-auth-wrap">
      <div className="cx-card cx-card--accent cx-card--center">
        <span className="cx-eyebrow">A small hiccup</span>
        <h1 className="cx-headline">
          {notFound
            ? "We couldn't find that"
            : "Something didn't go to plan"}
        </h1>
        <p className="cx-lead">
          {notFound
            ? "That page or plan isn't available from here. Your treatment plan itself is untouched."
            : "Nothing about your treatment plan has been changed. Please head back and try again — it usually clears straight away."}
        </p>
        <div
          className="cx-actions-row"
          style={{ justifyContent: "center", marginTop: 18 }}
        >
          <Link to="/portal" className="cx-btn cx-btn--primary">
            Back to my treatment
          </Link>
        </div>
        <p className="cx-note" style={{ marginTop: 16 }}>
          Still stuck? Write to us — we're happy to help.
        </p>
      </div>
    </div>
  );
}
