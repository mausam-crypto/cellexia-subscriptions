/** Elegant wizard progress for the routine builder. */
import { Fragment } from "react";

export function WizardSteps({
  labels,
  current,
}: {
  labels: string[];
  /** 1-based index of the current step. */
  current: number;
}) {
  return (
    <div className="cx-steps" aria-label={`Step ${current} of ${labels.length}`}>
      {labels.map((label, index) => {
        const stepNumber = index + 1;
        const state =
          stepNumber === current
            ? " is-current"
            : stepNumber < current
              ? " is-done"
              : "";
        return (
          <Fragment key={label}>
            {index > 0 ? <span className="cx-steps__bar" aria-hidden="true" /> : null}
            <span className={`cx-steps__item${state}`}>
              <span className="cx-steps__dot">{stepNumber}</span>
              {label}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}
