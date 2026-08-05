/** Small stat tile: eyebrow label, Gobold value, optional hint. */
export function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string | null;
}) {
  return (
    <div className="cx-stat">
      <div className="cx-stat__label">{label}</div>
      <div className="cx-stat__value">{value}</div>
      {hint ? <div className="cx-stat__hint">{hint}</div> : null}
    </div>
  );
}
