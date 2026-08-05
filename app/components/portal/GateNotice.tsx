/**
 * Calm gate notice for the pause / cancel windows. Purely presentational —
 * routes decide the copy, this renders it in the portal's card language.
 *
 * Two tones: "card" is a full gate screen (used by the cancel flow in place
 * of the reason form); "banner" is an inline notice above a page (used by
 * the treatment page when a pause attempt is blocked). No guilt, no
 * countdowns — the customer always keeps visible ways to act.
 */
import { Link } from "@remix-run/react";

export interface GateNoticeAction {
  to: string;
  label: string;
}

export function GateNotice({
  eyebrow,
  title,
  lines,
  actions = [],
  tone = "card",
  supportEmail = null,
}: {
  eyebrow?: string;
  title: string;
  lines: string[];
  actions?: GateNoticeAction[];
  /** "card" = full gate screen; "banner" = inline notice above a page. */
  tone?: "card" | "banner";
  /** Renders a subdued "Write to us" mailto link when provided. */
  supportEmail?: string | null;
}) {
  if (tone === "banner") {
    return (
      <div
        className="cx-banner cx-banner--info"
        role="status"
        aria-live="polite"
      >
        <p className="cx-banner__title">{title}</p>
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {actions.length > 0 ? (
          <p style={{ marginTop: 6 }}>
            {actions.map((action, index) => (
              <span key={action.to}>
                {index > 0 ? " · " : null}
                <Link to={action.to} className="cx-link-quiet">
                  {action.label}
                </Link>
              </span>
            ))}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="cx-card cx-card--accent cx-card--center">
      {eyebrow ? <span className="cx-eyebrow">{eyebrow}</span> : null}
      <h1 className="cx-headline">{title}</h1>
      {lines.map((line) => (
        <p key={line} className="cx-lead">
          {line}
        </p>
      ))}
      {actions.length > 0 ? (
        <div
          className="cx-actions-row"
          style={{ justifyContent: "center", marginTop: 18 }}
        >
          {actions.map((action, index) => (
            <Link
              key={action.to}
              to={action.to}
              className={`cx-btn ${index === 0 ? "cx-btn--primary" : "cx-btn--secondary"}`}
            >
              {action.label}
            </Link>
          ))}
        </div>
      ) : null}
      {supportEmail ? (
        <p className="cx-note" style={{ marginTop: 16 }}>
          Need help sooner? <a href={`mailto:${supportEmail}`}>Write to us</a>
        </p>
      ) : null}
    </div>
  );
}
