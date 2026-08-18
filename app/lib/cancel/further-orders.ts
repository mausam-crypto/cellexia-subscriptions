/**
 * Scheduled cancel vs the mirror's next-order pointer (v1.28.0 audit).
 *
 * `scheduleCancel` stamps `cancelScheduledAt`; from then on the billing
 * sweep refuses to bill once `cancelScheduledAt <= now` and the hourly job
 * ends the contract at that moment. The mirror's `nextBillingDate` does not
 * know that: with a day-based lock (e.g. 90 days) and monthly cycles the
 * last in-window cycle bills before the unlock day and the pointer lands
 * AFTER it — an order that will never exist. Every surface that promises
 * "your next order is on {date}" (upcoming-order reminder, portal home card,
 * detail hero) must ask this first, so the customer is never told about an
 * order or a charge that is not going to happen (honesty rule).
 *
 * Pure: no I/O, no clock — the comparison the sweep makes, applied to the
 * pointer. Same-instant is "no further order" (the sweep excludes
 * `cancelScheduledAt <= now`).
 */
export function hasFurtherOrders(contract: {
  cancelScheduledAt: Date | null;
  nextBillingDate: Date | null;
}): boolean {
  if (!contract.cancelScheduledAt) return true;
  if (!contract.nextBillingDate) return false;
  return contract.nextBillingDate.getTime() < contract.cancelScheduledAt.getTime();
}
