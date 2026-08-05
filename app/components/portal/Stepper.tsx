/**
 * Quantity stepper — a self-contained POST form: − / value / +.
 * Each button submits the new quantity; the route clamps and applies it via
 * core `updateLineQuantity`. Works without client-side JavaScript.
 */
export function QuantityStepper({
  contractId,
  lineId,
  quantity,
  title,
  min = 1,
  max = 12,
}: {
  contractId: string;
  lineId: string;
  quantity: number;
  title: string;
  min?: number;
  max?: number;
}) {
  return (
    <form method="post" className="cx-stepper" aria-label={`Quantity of ${title}`}>
      <input type="hidden" name="intent" value="quantity" />
      <input type="hidden" name="contractId" value={contractId} />
      <input type="hidden" name="lineId" value={lineId} />
      <button
        type="submit"
        className="cx-stepper__btn"
        name="quantity"
        value={quantity - 1}
        disabled={quantity <= min}
        aria-label={`One fewer ${title}`}
      >
        −
      </button>
      <span className="cx-stepper__value" aria-live="polite">
        {quantity}
      </span>
      <button
        type="submit"
        className="cx-stepper__btn"
        name="quantity"
        value={quantity + 1}
        disabled={quantity >= max}
        aria-label={`One more ${title}`}
      >
        +
      </button>
    </form>
  );
}
