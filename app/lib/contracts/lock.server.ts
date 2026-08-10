import prisma from "~/db.server";
import { addDaysTz, shopDayStartUtc } from "~/lib/dates.server";
import {
  numericIdFromGid,
  parsePlanIdsJson,
  planIdMatches,
} from "~/lib/ownership/ownership.server";

/**
 * Per-plan lock window: SellingPlanConfig.lockDays blocks every
 * CUSTOMER-initiated schedule reduction — skip, delay, frequency, next-date,
 * pause, swap, recurring-line removal, quantity decrease, cancel — for the
 * first N days after subscribing, so a plan's discounted first order cannot
 * be grabbed and instantly cancelled. Additions (add product / addon /
 * quantity increase) and recoveries (unskip, resume, reactivate, address,
 * payment update) stay available, and ADMIN / SYSTEM / DUNNING paths are
 * never blocked — the guard lives in the customer-facing routes and the
 * cancel engine, never in the contracts service.
 *
 * Terms as subscribed under: the sync create path stamps the covering
 * config's lockDays onto SubscriptionContract.lockDays once, at mirror
 * creation. The EFFECTIVE window is min(that stamp, the covering config's
 * CURRENT lockDays) — so enabling or raising the setting never locks a
 * subscriber who checked out before it existed (they were promised "cancel
 * anytime"), while lowering or disabling it releases everyone immediately.
 * A null stamp (pre-feature rows, imports, install backfills — subscribe-time
 * terms unknowable) is always exempt.
 *
 * Resolution: a contract is covered by a config when any line's
 * `sellingPlanId` is a member of that config's append-only `shopifyPlanIds`
 * union (both GID and numeric forms — the same membership rule ownership
 * classification uses). Deliberately NO product-id fallback: imported and
 * demo contracts carry no line plan ids and must stay exempt. The plan-id
 * route cannot be escaped from inside the window because line removal is
 * itself a locked action. When several configs match, the strictest current
 * lockDays wins.
 *
 * Window arithmetic (golden rule 5 — dates.server.ts, shop tz): the anchor
 * is the EARLIEST of firstChargeAt / createdAt (firstChargeAt is the
 * checkout order's creation instant when known; the min() guards the one
 * case where it lands later — a late renewal-settlement stamp — so a
 * contract can never flip back from unlocked to locked). The window ends at
 * shop-timezone MIDNIGHT of (anchor's calendar day + effective days): every
 * customer surface promises "available on {date}", and releasing at 00:00 of
 * that date makes the promise exactly true instead of up to a day late.
 */

export interface LockRule {
  lockDays: number;
  /** Both id forms of every plan id the config ever exposed. */
  planIds: ReadonlySet<string>;
}

export interface LockableContract {
  /** Commitment as subscribed under — null (pre-feature/import/backfill) = exempt. */
  lockDays: number | null;
  firstChargeAt: Date | null;
  createdAt: Date;
  lines: Array<{ sellingPlanId: string | null }>;
}

export interface LockState {
  locked: boolean;
  /** End of the window (shop-tz midnight); null when no window applies. */
  until: Date | null;
  /** The effective day count; 0 when no window applies. */
  lockDays: number;
}

const UNLOCKED: LockState = { locked: false, until: null, lockDays: 0 };

/** Both id forms (GID + numeric) of a config's shopifyPlanIds column. */
function planIdSet(shopifyPlanIds: unknown): ReadonlySet<string> {
  const set = new Set<string>();
  for (const id of parsePlanIdsJson(shopifyPlanIds)) {
    set.add(id);
    const numeric = numericIdFromGid(id);
    if (numeric) set.add(numeric);
  }
  return set;
}

/**
 * The shop's lock rules — configs with a non-zero lockDays, ACTIVE OR NOT:
 * deactivating a plan stops offering it on the storefront, it does not
 * release commitments already entered under it. Setting lockDays to 0 (or
 * deleting the config) does.
 */
export async function getLockRules(shopId: string): Promise<LockRule[]> {
  const configs = await prisma.sellingPlanConfig.findMany({
    where: { shopId, lockDays: { gt: 0 } },
    select: { lockDays: true, shopifyPlanIds: true },
  });
  return configs.map((c) => ({
    lockDays: c.lockDays,
    planIds: planIdSet(c.shopifyPlanIds),
  }));
}

/**
 * The strictest current lockDays covering these line plan ids — also used by
 * the sync create path to stamp SubscriptionContract.lockDays at birth.
 */
export function maxLockDaysForPlanIds(
  rules: readonly LockRule[],
  planIds: ReadonlyArray<string | null | undefined>,
): number {
  let max = 0;
  for (const planId of planIds) {
    if (!planId) continue;
    for (const rule of rules) {
      if (rule.lockDays > max && planIdMatches(rule.planIds, planId)) {
        max = rule.lockDays;
      }
    }
  }
  return max;
}

/** Pure lock computation against already-loaded rules (see module doc). */
export function lockStateFor(
  rules: readonly LockRule[],
  contract: LockableContract,
  tz: string,
  now: Date = new Date(),
): LockState {
  // Terms as subscribed under: no stamp (or a 0 stamp) = never locked.
  const stamped = contract.lockDays ?? 0;
  if (stamped <= 0 || rules.length === 0) return UNLOCKED;

  const current = maxLockDaysForPlanIds(
    rules,
    contract.lines.map((l) => l.sellingPlanId),
  );
  const effective = Math.min(stamped, current);
  if (effective <= 0) return UNLOCKED;

  const anchor =
    contract.firstChargeAt && contract.firstChargeAt < contract.createdAt
      ? contract.firstChargeAt
      : contract.createdAt;
  const until = addDaysTz(shopDayStartUtc(anchor, tz), effective, tz);
  return { locked: now < until, until, lockDays: effective };
}

/** One-shot resolution: fetch the shop's rules and compute the state. */
export async function resolveLockState(
  shopId: string,
  contract: LockableContract,
  tz: string,
  now: Date = new Date(),
): Promise<LockState> {
  return lockStateFor(await getLockRules(shopId), contract, tz, now);
}
