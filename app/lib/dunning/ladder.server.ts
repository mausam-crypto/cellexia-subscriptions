import { addDaysTz } from "~/lib/dates.server";

/**
 * Pure retry-ladder math — no DB, no Shopify. Kept import-light so the test
 * suite exercises the REAL scheduling contract (tests/dunning-ladder.test.ts)
 * instead of a hand-maintained mirror.
 */

/**
 * The next retry is the FIRST configured offset (anchored to the case's
 * openedAt, index 0 being the original charge) whose moment is still ahead of
 * `now`. Undefined ⇒ every rung has passed ⇒ the ladder is exhausted.
 *
 * Selecting by TIME rather than by counting failed attempts means the 1-hour
 * backup-card retry, an admin "Retry now" and payment-method-updated
 * immediate retries never silently consume configured rungs — the payday-
 * aligned day-7/day-14 retries the merchant configured always happen. It
 * also guarantees the scheduled retry is strictly in the future, so a
 * mis-sized payday snap window can never make a later rung fire immediately.
 */
export function selectNextRetryOffsetDays(
  softRetryDays: readonly number[],
  openedAt: Date,
  now: Date,
  tz: string,
): number | undefined {
  return softRetryDays
    .slice(1)
    .find((d) => addDaysTz(openedAt, d, tz).getTime() > now.getTime());
}
