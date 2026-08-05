/** Elegant milestone badge — benefits accumulate, never pressure. */
export function MilestoneBadge({
  label,
  dateLabel,
}: {
  label: string;
  dateLabel?: string | null;
}) {
  return (
    <span className="cx-badge cx-badge--blue">
      {label}
      {dateLabel ? <span className="cx-badge__date">{dateLabel}</span> : null}
    </span>
  );
}
