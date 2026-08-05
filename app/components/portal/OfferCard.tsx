/**
 * A save-offer card in the cancel flow. Structural (no-cost) offers get the
 * signature blue accent and lead the list.
 *
 * Parameterised offers render their choices INSIDE the accept form (delay
 * weeks, pause length or date, swap target, removal pick, care details) so
 * the customer's actual selection travels with the accept POST — the flow
 * executes exactly what was promised, never a hidden default.
 */
import type { ReactNode } from "react";

export function OfferCard({
  sessionId,
  offerType,
  title,
  description,
  structural,
  children,
}: {
  sessionId: string;
  offerType: string;
  title: string;
  description: string;
  structural: boolean;
  /** Choice inputs (radios / selects / date / textarea) for this offer. */
  children?: ReactNode;
}) {
  return (
    <div className={`cx-offer${structural ? " cx-offer--structural" : ""}`}>
      <h3 className="cx-offer__title">{title}</h3>
      <p className="cx-offer__desc">{description}</p>
      <form method="post">
        <input type="hidden" name="intent" value="accept-offer" />
        <input type="hidden" name="sessionId" value={sessionId} />
        <input type="hidden" name="offerType" value={offerType} />
        {children}
        <button type="submit" className="cx-btn cx-btn--secondary cx-btn--block">
          Yes, do this instead
        </button>
      </form>
    </div>
  );
}
