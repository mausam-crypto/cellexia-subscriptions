import { addDaysTz, shopDayStartUtc } from "~/lib/dates.server";

/**
 * Pure helpers behind the v1.28.0 Stage D flexibility surfaces (P2.6 vacation
 * hold with dates + pause exit ramp, P2.7 "already out" branch, P2.9 supply
 * meter). Every rule here mirrors the contracts service (pauseUntil /
 * extendPause / sendNextOrderTomorrow) so the portal offers exactly what the
 * service accepts — the service stays the authority and refuses (typed) when
 * a stale page disagrees. No I/O, no settings reads: callers pass the
 * settings values they already hold.
 */

/** Registry default for settings.portal.pauseExtendChoicesWeeks. */
export const DEFAULT_PAUSE_EXTEND_WEEKS: readonly number[] = [2, 4];

/** One "need a little longer?" choice on a PAUSED subscription. */
export interface PauseExtendChoice {
  weeks: number;
  /** The new resume day (shop-tz day start) the choice would set. */
  resumeAt: Date;
}

/**
 * The extend choices a hold may still take: `weeks` (settings
 * portal.pauseExtendChoicesWeeks) added to the current resume day, kept
 * only while within pause.maxMonths × 30 days of the pause START (the same
 * clamp `extendPause` applies, measured from `pausedAt`). Deduped, sorted,
 * empty when the hold has no resume day (nothing to extend from).
 */
export function pauseExtendChoices(input: {
  resumeAt: Date | null;
  pausedAt: Date | null;
  /** settings.portal.pauseExtendChoicesWeeks (missing ⇒ the registry default). */
  weeks?: readonly unknown[] | null;
  maxMonths: number;
  tz: string;
  now?: Date;
}): PauseExtendChoice[] {
  const { resumeAt, tz } = input;
  if (!resumeAt || Number.isNaN(resumeAt.getTime())) return [];
  const anchor = input.pausedAt ?? input.now ?? new Date();
  const currentDay = shopDayStartUtc(resumeAt, tz);
  const maxDay = shopDayStartUtc(
    addDaysTz(anchor, Math.max(1, Math.floor(input.maxMonths)) * 30, tz),
    tz,
  );
  const source = Array.isArray(input.weeks)
    ? input.weeks
    : DEFAULT_PAUSE_EXTEND_WEEKS;
  const weeks = [...new Set(source)]
    .filter(
      (w): w is number =>
        typeof w === "number" && Number.isInteger(w) && w >= 1 && w <= 26,
    )
    .sort((a, b) => a - b);
  const out: PauseExtendChoice[] = [];
  for (const w of weeks) {
    const day = shopDayStartUtc(addDaysTz(currentDay, w * 7, tz), tz);
    if (day.getTime() > maxDay.getTime()) continue;
    if (day.getTime() <= currentDay.getTime()) continue;
    out.push({ weeks: w, resumeAt: day });
  }
  return out;
}

/**
 * The resume-day window a NEW date-based hold accepts (mirrors `pauseUntil`):
 * earliest tomorrow (shop tz), latest today + pause.maxMonths × 30 days.
 */
export function pauseUntilBounds(input: {
  maxMonths: number;
  tz: string;
  now?: Date;
}): { min: Date; max: Date } {
  const now = input.now ?? new Date();
  const today = shopDayStartUtc(now, input.tz);
  return {
    min: addDaysTz(today, 1, input.tz),
    max: shopDayStartUtc(
      addDaysTz(now, Math.max(1, Math.floor(input.maxMonths)) * 30, input.tz),
      input.tz,
    ),
  };
}

/**
 * P2.7 "already out" — the churn model's predicted-empty day is today or
 * earlier while the next order is still more than a day away, so pulling it
 * to tomorrow (sendNextOrderTomorrow) actually helps. The standing run-out
 * prompt (runsOutBeforeNextDelivery) covers the future-empty case; the two
 * are exclusive by construction.
 */
export function alreadyOut(
  predictedEmptyDate: Date | null,
  nextBillingDate: Date | null,
  now: Date,
  tz: string,
): boolean {
  if (!predictedEmptyDate || !nextBillingDate) return false;
  if (predictedEmptyDate.getTime() > now.getTime()) return false;
  const tomorrow = addDaysTz(shopDayStartUtc(now, tz), 1, tz);
  return nextBillingDate.getTime() > tomorrow.getTime();
}

/**
 * P2.9 supply meter — whole days of product left according to the churn
 * model's `predictedEmptyDate` (ceil; never below 1). Null when there is no
 * prediction or it already passed (the "already out" branch owns that
 * moment — the meter never says "0 days left" as a fact).
 */
export function daysOfSupplyLeft(
  predictedEmptyDate: Date | null,
  now: Date,
): number | null {
  if (!predictedEmptyDate || Number.isNaN(predictedEmptyDate.getTime())) {
    return null;
  }
  const ms = predictedEmptyDate.getTime() - now.getTime();
  if (ms <= 0) return null;
  return Math.max(1, Math.ceil(ms / 86_400_000));
}
