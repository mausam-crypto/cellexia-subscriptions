/**
 * Test-local mirror of the billing idempotency-key contract.
 *
 * The billing module does not export a pure key builder — the format lives
 * inline in app/lib/billing/scheduler.server.ts and
 * app/lib/dunning/engine.server.ts as:
 *
 *   const idempotencyKey = `${contract.id}:${cycleIndex}:${attemptNumber}`;
 *
 * per golden rule 4 (docs/ARCHITECTURE.md): unique in the DB AND passed to
 * subscriptionBillingAttemptCreate, so Shopify dedupes and double charges are
 * impossible. tests/idempotency.test.ts asserts this helper matches the real
 * modules' source, so a drift in either place fails the suite.
 *
 * NOTE: contractLocalId is the LOCAL cuid (never the Shopify GID — GIDs
 * contain ":" and would corrupt the 3-part format).
 */

export function buildIdempotencyKey(
  contractLocalId: string,
  cycleIndex: number,
  attemptNumber: number,
): string {
  return `${contractLocalId}:${cycleIndex}:${attemptNumber}`;
}

/**
 * Attempt numbering contract (scheduler step e / dunning fireRetry):
 * attemptNumber = count of existing attempts for (contract, cycle) + 1.
 * 1 = the scheduled charge, 2+ = dunning retries.
 */
export function nextAttemptNumber(priorAttemptsForCycle: number): number {
  return priorAttemptsForCycle + 1;
}
