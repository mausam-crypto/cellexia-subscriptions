import prisma from "~/db.server";
import { getSetting } from "~/lib/settings/settings.server";
import { addDaysTz, shopDayStartUtc } from "~/lib/dates.server";

/**
 * Charge timing — the ONE place "when does this renewal actually charge" is
 * computed (v1.28.0, P2.1). The billing sweep, the portal and the
 * upcoming-order reminder all read the same instant, so the "you can make
 * changes until …" line can never contradict the sweep.
 *
 *   chargeMoment(d) = shopDayStartUtc(d, tz) + settings.billing.chargeHourLocal h
 *
 * With the default hour 0 this is byte-for-byte the pre-v1.28 behaviour (the
 * first 5-minute run after shop midnight of nextBillingDate). The edit cut-off
 * IS the charge moment: the customer can change the order until then.
 *
 * `ChargeTiming` is the resolved input; callers that already hold the shop
 * timezone + settings pass it directly (sync helpers), everything else passes
 * a shopId and lets `resolveChargeTiming` load it — failure-contained, a
 * broken settings read degrades to hour 0 rather than blocking a portal page
 * or a reminder run.
 */

export interface ChargeTiming {
  /** Shop IANA timezone. */
  tz: string;
  /** settings.billing.chargeHourLocal (0–23). */
  chargeHourLocal: number;
  /**
   * settings.billing.preparingWindowHours: the "preparing" state's upper
   * bound when NO attempt has claimed the billing day (absent → default 6).
   */
  preparingWindowHours?: number;
}

const HOUR_MS = 3_600_000;
const DEFAULT_PREPARING_WINDOW_HOURS = 6;

/** Defensive coercion for the preparing window (integer 1–72, else default). */
export function normalizePreparingWindowHours(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 72
    ? value
    : DEFAULT_PREPARING_WINDOW_HOURS;
}

/** Defensive coercion: anything that is not an integer 0–23 means hour 0. */
export function normalizeChargeHour(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 23
    ? value
    : 0;
}

/**
 * Load `{tz, chargeHourLocal}` for a shop. Contained: a failed shop or
 * settings read yields hour 0 (and the given `tz` fallback, "UTC" last).
 */
export async function resolveChargeTiming(
  shopIdOrTiming: string | ChargeTiming,
  tzFallback?: string,
): Promise<ChargeTiming> {
  if (shopIdOrTiming != null && typeof shopIdOrTiming === "object") {
    return {
      tz: shopIdOrTiming.tz,
      chargeHourLocal: normalizeChargeHour(shopIdOrTiming.chargeHourLocal),
      preparingWindowHours: normalizePreparingWindowHours(
        shopIdOrTiming.preparingWindowHours,
      ),
    };
  }
  // Defensive: a caller with no shop id (a partial mirror row) still gets a
  // usable timing (fallback tz, default hour) — never a thrown page.
  const shopId = typeof shopIdOrTiming === "string" ? shopIdOrTiming : "";
  let tz = tzFallback ?? "UTC";
  let chargeHourLocal = 0;
  let preparingWindowHours = DEFAULT_PREPARING_WINDOW_HOURS;
  try {
    if (!tzFallback) {
      const shop = await prisma.shop.findUnique({
        where: { id: shopId },
        select: { ianaTimezone: true },
      });
      if (shop?.ianaTimezone) tz = shop.ianaTimezone;
    }
  } catch (err) {
    console.error("[billing] charge timing: shop tz read failed", shopId, err);
  }
  try {
    const billing = await getSetting(shopId, "billing");
    chargeHourLocal = normalizeChargeHour(billing?.chargeHourLocal);
    preparingWindowHours = normalizePreparingWindowHours(
      (billing as { preparingWindowHours?: unknown } | null)?.preparingWindowHours,
    );
  } catch (err) {
    console.error("[billing] charge timing: settings read failed", shopId, err);
  }
  return { tz, chargeHourLocal, preparingWindowHours };
}

/** The UTC instant a renewal due on `nextBillingDate` is charged. */
export function chargeMomentUtcSync(
  nextBillingDate: Date,
  timing: ChargeTiming,
): Date {
  const dayStart = shopDayStartUtc(nextBillingDate, timing.tz);
  return new Date(
    dayStart.getTime() + normalizeChargeHour(timing.chargeHourLocal) * HOUR_MS,
  );
}

/** Async form: `shopId` (loads tz + settings) or a resolved `ChargeTiming`. */
export async function chargeMomentUtc(
  shopIdOrTiming: string | ChargeTiming,
  nextBillingDate: Date,
): Promise<Date> {
  const timing = await resolveChargeTiming(shopIdOrTiming);
  return chargeMomentUtcSync(nextBillingDate, timing);
}

/**
 * The instant until which the customer can still change the order due on
 * `nextBillingDate` — identical to the charge moment by definition (there is
 * no separate cut-off the sweep would honour).
 */
export function editCutoffSync(nextBillingDate: Date, timing: ChargeTiming): Date {
  return chargeMomentUtcSync(nextBillingDate, timing);
}

export async function editCutoff(
  shopIdOrTiming: string | ChargeTiming,
  nextBillingDate: Date,
): Promise<Date> {
  return chargeMomentUtc(shopIdOrTiming, nextBillingDate);
}

/**
 * Sweep window: every contract whose charge moment is at or before `now` is
 * due — i.e. nextBillingDate < (start of the shop day containing
 * `now − chargeHour`) + 1 day. Hour 0 reduces to the pre-v1.28 expression
 * `addDaysTz(shopDayStartUtc(now), 1)` exactly. Overdue contracts (days past)
 * stay inside the window — overdue handling is untouched.
 */
export function dueBeforeUtc(now: Date, timing: ChargeTiming): Date {
  const shifted = new Date(
    now.getTime() - normalizeChargeHour(timing.chargeHourLocal) * HOUR_MS,
  );
  return addDaysTz(shopDayStartUtc(shifted, timing.tz), 1, timing.tz);
}

/** Has the charge moment for `nextBillingDate` arrived? */
export function isChargeDue(
  nextBillingDate: Date,
  timing: ChargeTiming,
  now: Date,
): boolean {
  return chargeMomentUtcSync(nextBillingDate, timing).getTime() <= now.getTime();
}

// ── "Preparing your order" state ────────────────────────────────────────────

export interface AttemptLike {
  status: string;
  originatingAction?: string | null;
  startedAt?: Date | null;
  scheduledFor: Date;
  supersededAt?: Date | null;
}

export interface PreparingContractLike {
  id?: string;
  status: string;
  nextBillingDate: Date | null;
  billingAttempts?: AttemptLike[];
}

/**
 * Billing day reached — the order is being prepared and the cycle can no
 * longer be edited. True when, for an ACTIVE contract:
 *
 *  - a PENDING attempt is in flight (Shopify confirmed it — `startedAt` set —
 *    or the sweep's own un-started SCHEDULER residue, which the next sweep
 *    re-fires); a dunning retry parked un-started (fireRetry backoff) is a
 *    payment issue, not "preparing"; or
 *  - `now` ≥ the charge moment of nextBillingDate and no attempt has claimed
 *    that billing day yet (the gap between the charge moment and the next
 *    5-minute sweep) — bounded by `preparingWindowHours` after the charge
 *    moment: past it the renewal is a stuck one (cycle lookup failing every
 *    tick, jobs runner down), the classic controls return and the
 *    STUCK_CONTRACTS alert owns it. A FAILED / CHALLENGED / EXPIRED newest
 *    attempt for the day means dunning owns the cycle (payment-issue surfaces
 *    speak), a SUCCESS one means mirror lag (already billed) — neither is
 *    "preparing".
 *
 * Pure: pass the contract's attempts (`billingAttempts`, any order); the async
 * wrapper below loads them when absent.
 */
export function isPreparingOrderSync(
  contract: PreparingContractLike,
  timing: ChargeTiming,
  now: Date,
): boolean {
  return preparingOrderDate(contract, timing, now) != null;
}

/** The in-flight PENDING attempt `isPreparingOrderSync` keys on, if any. */
function inFlightAttempt(attempts: AttemptLike[]): AttemptLike | null {
  let found: AttemptLike | null = null;
  for (const a of attempts) {
    if (
      a.status === "PENDING" &&
      (a.startedAt != null || (a.originatingAction ?? "SCHEDULER") === "SCHEDULER") &&
      (!found || a.scheduledFor.getTime() < found.scheduledFor.getTime())
    ) {
      found = a;
    }
  }
  return found;
}

/**
 * The billing date of the order being prepared, or null when the contract is
 * not in the "preparing" state (same predicate as `isPreparingOrderSync`).
 *
 * While a PENDING attempt is in flight the sweep has ALREADY advanced the
 * mirror's `nextBillingDate` by one interval (scheduler.server.ts,
 * "optimistically"), so `contract.nextBillingDate` names the FOLLOWING
 * cycle at that moment; the order being prepared is the attempt's own
 * `scheduledFor` (the nextBillingDate it was created for). Portal surfaces
 * print this date under "Preparing" — never the advanced pointer — so the
 * header, the estimate's lines/total (cycle N) and the "following delivery"
 * note agree. In the other branch (charge moment passed, no attempt yet)
 * the mirror has not moved and the date is `nextBillingDate` itself.
 */
export function preparingOrderDate(
  contract: PreparingContractLike,
  timing: ChargeTiming,
  now: Date,
): Date | null {
  if (contract.status !== "ACTIVE" || !contract.nextBillingDate) return null;
  const attempts = (contract.billingAttempts ?? []).filter(
    (a) => a.supersededAt == null,
  );
  const inFlight = inFlightAttempt(attempts);
  if (inFlight) {
    return inFlight.scheduledFor.getTime() <= contract.nextBillingDate.getTime()
      ? inFlight.scheduledFor
      : contract.nextBillingDate;
  }
  if (!isChargeDue(contract.nextBillingDate, timing, now)) return null;
  const chargeMoment = chargeMomentUtcSync(contract.nextBillingDate, timing);
  const windowMs =
    normalizePreparingWindowHours(timing.preparingWindowHours) * HOUR_MS;
  if (now.getTime() >= chargeMoment.getTime() + windowMs) return null;
  // Any (non-superseded) attempt scheduled for this billing day or later has
  // claimed the cycle: PENDING was handled above, everything else belongs to
  // dunning / the mirror — not "preparing".
  const dayStart = shopDayStartUtc(contract.nextBillingDate, timing.tz);
  const claimed = attempts.some(
    (a) => a.scheduledFor.getTime() >= dayStart.getTime(),
  );
  return claimed ? null : contract.nextBillingDate;
}

/**
 * Async form: resolves timing from `shopId` (or takes a `ChargeTiming`) and
 * loads the contract's attempts when the caller did not include them.
 * Contained — any read failure answers false (never block a portal page).
 */
export async function isPreparingOrder(
  contract: PreparingContractLike,
  shopIdOrTiming: string | ChargeTiming,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const timing = await resolveChargeTiming(shopIdOrTiming);
    let attempts = contract.billingAttempts;
    if (!attempts && contract.id) {
      attempts = await prisma.billingAttempt.findMany({
        where: { contractId: contract.id },
        select: {
          status: true,
          originatingAction: true,
          startedAt: true,
          scheduledFor: true,
          supersededAt: true,
        },
      });
    }
    return isPreparingOrderSync(
      { ...contract, billingAttempts: attempts ?? [] },
      timing,
      now,
    );
  } catch (err) {
    console.error("[billing] isPreparingOrder failed", contract.id, err);
    return false;
  }
}
