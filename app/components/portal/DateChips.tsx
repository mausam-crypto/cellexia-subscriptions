/**
 * Quick "delay by N weeks" chips — one POST form, each chip is a submit
 * button carrying its week count and showing the resulting date underneath.
 */
export interface DateChipOption {
  weeks: number;
  label: string;
  dateLabel: string;
}

export function DateChips({
  contractId,
  options,
}: {
  contractId: string;
  options: DateChipOption[];
}) {
  return (
    <form method="post" className="cx-chip-row">
      <input type="hidden" name="intent" value="delay" />
      <input type="hidden" name="contractId" value={contractId} />
      {options.map((option) => (
        <button
          key={option.weeks}
          type="submit"
          className="cx-chip"
          name="weeks"
          value={option.weeks}
        >
          {option.label}
          <span className="cx-chip__sub">{option.dateLabel}</span>
        </button>
      ))}
    </form>
  );
}
