/** Warm confirmation / info banner. */
import type { ReactNode } from "react";

export function ConfirmBanner({
  tone = "success",
  title,
  children,
}: {
  tone?: "success" | "info";
  title?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`cx-banner cx-banner--${tone}`}
      role="status"
      aria-live="polite"
    >
      {title ? <p className="cx-banner__title">{title}</p> : null}
      <p>{children}</p>
    </div>
  );
}
