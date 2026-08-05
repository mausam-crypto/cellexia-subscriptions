/** Large tappable card for the dashboard's four prominent actions. */
import { Link } from "@remix-run/react";

export function ActionCard({
  to,
  title,
  description,
}: {
  to: string;
  title: string;
  description: string;
}) {
  return (
    <Link to={to} className="cx-action-card">
      <h3 className="cx-action-card__title">{title}</h3>
      <p className="cx-action-card__desc">{description}</p>
    </Link>
  );
}
