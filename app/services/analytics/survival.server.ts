/**
 * Survival analysis [analytics].
 *
 * % of subscribers remaining after rebill 1/2/3 and 90/180/365 days, with
 * exits split into voluntary cancellations vs payment-failure (dunning
 * EXHAUSTED) losses — including contracts the dunning engine parked in a
 * terminal PAUSE and never recovered. Exposed on the executive dashboard and
 * the analytics survival tab; re-exported from services/analytics/
 * metrics.server per the cross-service contract.
 *
 * Censoring is SYMMETRIC: the at-risk set of every checkpoint contains only
 * contracts whose observation window covers that checkpoint — exits and
 * survivors alike. Admitting exits of any age while censoring young
 * survivors would bias every curve downward (worst case: a 2-month-old shop
 * "showing" 0% survival at 365 days).
 *
 * Null-vs-zero semantics: a percentage is `null` when the checkpoint is not
 * observable yet (`eligible === 0` — nobody old enough); `0` means observed
 * and gone (everyone eligible exited). Consumers must render null as
 * no-data, never as 0%.
 */
import prisma from "~/db.server";
import { daysBetween, isoDate } from "~/lib/dates";
import { effectiveCancelledAt } from "~/services/analytics/cohorts.server";

export type SurvivalCohortBy = "startMonth" | "widgetVersion" | "intervalWeeks";

export const SURVIVAL_COHORT_BY: readonly SurvivalCohortBy[] = [
  "startMonth",
  "widgetVersion",
  "intervalWeeks",
];

export type ExitKind = "VOLUNTARY" | "PAYMENT_FAILURE";

export interface SurvivalPoint {
  /** Human label, e.g. "Rebill 2" or "180 days". */
  label: string;
  kind: "REBILL" | "DAYS";
  /** Rebill number or day count, matching `kind`. */
  threshold: number;
  /**
   * At-risk sample size: contracts old enough (at their cadence, for rebill
   * points) to be observed at this checkpoint — exits and survivors alike.
   */
  eligible: number;
  /**
   * Percentages are `null` when `eligible === 0` (checkpoint not observable
   * yet); `0` means observed and gone. For REBILL points `remainingPercent`
   * is the share with `successfulOrders >= threshold + 1` (the documented
   * paid-order rule); for DAYS points it is the complement of exits.
   */
  remainingPercent: number | null;
  voluntaryExitPercent: number | null;
  paymentFailureExitPercent: number | null;
  /**
   * REBILL points only: share of eligible contracts still alive but not yet
   * at `threshold + 1` successful orders (paused / skipping / mid-dunning).
   * remaining + voluntary + paymentFailure + pending ≈ 100 for rebill
   * points (rounding aside); DAYS points report 0. Null when `eligible` is 0.
   */
  pendingPercent: number | null;
}

export interface SurvivalCurve {
  cohort: string;
  contracts: number;
  points: SurvivalPoint[];
  /**
   * Per-checkpoint at-risk sample size, parallel to `points`
   * (`atRisk[i] === points[i].eligible`) — lets the UI grey out thin data.
   */
  atRisk: number[];
}

const REBILL_CHECKPOINTS = [1, 2, 3] as const;
const DAY_CHECKPOINTS = [90, 180, 365] as const;

export interface MemberInput {
  /** Contract's real start (treatmentStartedAt, falling back to createdAt). */
  createdAt: Date;
  /** Effective churn date (app-stamped, or updatedAt for terminal-status
   * webhook cancels); null while the contract lives. */
  cancelledAt: Date | null;
  cancelReason: string | null;
  /** Current contract status — guards stale EXHAUSTED dunning phases. */
  status: string;
  successfulOrders: number;
  intervalWeeks: number;
  widgetVersion: string | null;
  dunningPhase: string | null;
  /** End of the post-dunning grace window; dates exhausted-pause exits. */
  dunningGraceUntil: Date | null;
  /** Last dunning-state write; fallback exit date for exhausted contracts. */
  dunningUpdatedAt: Date | null;
}

/**
 * PURE — classify how a contract exited. Payment failure when dunning
 * exhausted (or the cancel reason references payment); voluntary otherwise.
 * Contracts that were merged into another contract (cancelReason MERGED) are
 * consolidation, not churn — never an exit. A contract with no `cancelledAt`
 * still counts as a PAYMENT_FAILURE exit when the dunning engine exhausted
 * it and it never recovered (phase EXHAUSTED with a non-ACTIVE status —
 * five of the seven dunning strategies end in a terminal PAUSE that no job
 * ever cancels or resumes; the status guard matters because a manual
 * reactivation can leave a stale EXHAUSTED phase behind until the next
 * successful charge). Returns null for contracts that have not exited.
 */
export function classifyExit(input: {
  cancelledAt: Date | null;
  dunningPhase: string | null;
  cancelReason: string | null;
  status?: string | null;
}): ExitKind | null {
  if (input.cancelReason === "MERGED") return null;
  if (input.cancelledAt) {
    if (
      input.dunningPhase === "EXHAUSTED" ||
      (input.cancelReason ?? "").toUpperCase().includes("PAYMENT")
    ) {
      return "PAYMENT_FAILURE";
    }
    return "VOLUNTARY";
  }
  if (
    input.dunningPhase === "EXHAUSTED" &&
    input.status != null &&
    input.status !== "ACTIVE"
  ) {
    return "PAYMENT_FAILURE";
  }
  return null;
}

/**
 * PURE — a contract has "survived rebill n" when it completed at least n + 1
 * successful paid orders (the first order plus n rebills).
 */
export function survivedRebill(
  successfulOrders: number,
  rebillNumber: number,
): boolean {
  return successfulOrders >= rebillNumber + 1;
}

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * Exit date of a member that exited without an app-stamped `cancelledAt`
 * (dunning-exhausted terminal pause): the end of the grace window when
 * known, else the last dunning-state write.
 */
function exitDateOf(m: MemberInput): Date | null {
  if (m.cancelledAt) return m.cancelledAt;
  return m.dunningGraceUntil ?? m.dunningUpdatedAt;
}

/** Member was merged away on or before `byDays` days of life — censored. */
function mergedOutBy(m: MemberInput, byDays: number): boolean {
  return (
    m.cancelReason === "MERGED" &&
    m.cancelledAt != null &&
    daysBetween(m.createdAt, m.cancelledAt) <= byDays
  );
}

/**
 * PURE, exported for tests — build the six checkpoint points for a member
 * set.
 *
 * Eligibility (the at-risk set) is symmetric: only contracts whose
 * observation window covers the checkpoint enter it. For rebill n that means
 * age >= n × intervalWeeks × 7 days, OR proof of survival
 * (`successfulOrders >= n + 1` — covers cadence switches, where the CURRENT
 * interval would mis-date the contract's history). For day checkpoints it
 * means age >= the day count. Exits get no special admission.
 *
 * Rebill `remainingPercent` follows the documented paid-order rule
 * (`successfulOrders >= n + 1`), not elapsed time; eligible contracts that
 * are alive but have not paid enough (paused / skipping / mid-dunning) are
 * reported separately as `pendingPercent`.
 */
export function buildPoints(members: MemberInput[], now: Date): SurvivalPoint[] {
  const points: SurvivalPoint[] = [];

  for (const rebill of REBILL_CHECKPOINTS) {
    const eligible = members.filter((m) => {
      if (survivedRebill(m.successfulOrders, rebill)) return true;
      const thresholdDays = rebill * Math.max(1, m.intervalWeeks) * 7;
      if (mergedOutBy(m, thresholdDays)) return false;
      return daysBetween(m.createdAt, now) >= thresholdDays;
    });
    let survivors = 0;
    let voluntary = 0;
    let paymentFailure = 0;
    for (const m of eligible) {
      if (survivedRebill(m.successfulOrders, rebill)) {
        survivors++;
        continue;
      }
      const kind = classifyExit(m);
      if (kind === "PAYMENT_FAILURE") paymentFailure++;
      else if (kind === "VOLUNTARY") voluntary++;
    }
    const n = eligible.length;
    points.push({
      label: `Rebill ${rebill}`,
      kind: "REBILL",
      threshold: rebill,
      eligible: n,
      remainingPercent: n === 0 ? null : pct(survivors, n),
      voluntaryExitPercent: n === 0 ? null : pct(voluntary, n),
      paymentFailureExitPercent: n === 0 ? null : pct(paymentFailure, n),
      pendingPercent:
        n === 0 ? null : pct(n - survivors - voluntary - paymentFailure, n),
    });
  }

  for (const days of DAY_CHECKPOINTS) {
    const eligible = members.filter(
      (m) => !mergedOutBy(m, days) && daysBetween(m.createdAt, now) >= days,
    );
    let voluntary = 0;
    let paymentFailure = 0;
    for (const m of eligible) {
      const kind = classifyExit(m);
      if (kind == null) continue;
      const exitAt = exitDateOf(m);
      const exitedByDay =
        exitAt == null || daysBetween(m.createdAt, exitAt) <= days;
      if (!exitedByDay) continue;
      if (kind === "PAYMENT_FAILURE") paymentFailure++;
      else voluntary++;
    }
    const n = eligible.length;
    points.push({
      label: `${days} days`,
      kind: "DAYS",
      threshold: days,
      eligible: n,
      remainingPercent: n === 0 ? null : pct(n - voluntary - paymentFailure, n),
      voluntaryExitPercent: n === 0 ? null : pct(voluntary, n),
      paymentFailureExitPercent: n === 0 ? null : pct(paymentFailure, n),
      pendingPercent: n === 0 ? null : 0,
    });
  }

  return points;
}

function groupKeyFor(member: MemberInput, cohortBy: SurvivalCohortBy): string {
  switch (cohortBy) {
    case "startMonth":
      return isoDate(member.createdAt).slice(0, 7);
    case "widgetVersion":
      return member.widgetVersion ?? "unknown";
    case "intervalWeeks":
      return `${member.intervalWeeks} weeks`;
  }
}

const MAX_COHORT_CURVES = 24;

/**
 * PURE, exported for tests — order cohort keys so the MAX_COHORT_CURVES cap
 * keeps the most relevant cohorts: `startMonth` newest first (a cap must
 * never silently drop the recent months a merchant needs to judge a
 * change), `intervalWeeks` in numeric cadence order, otherwise
 * lexicographic.
 */
export function sortCohortKeys(
  keys: string[],
  cohortBy: SurvivalCohortBy,
): string[] {
  const sorted = [...keys].sort();
  if (cohortBy === "startMonth") return sorted.reverse();
  if (cohortBy === "intervalWeeks") {
    return sorted.sort(
      (a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10),
    );
  }
  return sorted;
}

function toCurve(cohort: string, members: MemberInput[], now: Date): SurvivalCurve {
  const points = buildPoints(members, now);
  return {
    cohort,
    contracts: members.length,
    points,
    atRisk: points.map((p) => p.eligible),
  };
}

/**
 * Survival curves for a shop. Always returns the overall "all" curve first;
 * when `cohortBy` is provided, one additional curve per cohort value follows
 * — capped at MAX_COHORT_CURVES (24) cohort curves, keeping the NEWEST
 * start-month keys (see `sortCohortKeys`).
 *
 * Member dating uses the contract's real Shopify start
 * (`treatmentStartedAt`) and the effective churn date (`cancelledAt`, or
 * `updatedAt` for terminal-status webhook cancels the app never stamped).
 */
export async function getSurvivalCurves(
  shop: string,
  cohortBy?: SurvivalCohortBy,
): Promise<SurvivalCurve[]> {
  const now = new Date();
  const contracts = await prisma.subscriptionContract.findMany({
    where: { shop },
    select: {
      createdAt: true,
      treatmentStartedAt: true,
      updatedAt: true,
      status: true,
      cancelledAt: true,
      cancelReason: true,
      successfulOrders: true,
      intervalWeeks: true,
      widgetVersion: true,
      dunningState: { select: { phase: true, graceUntil: true, updatedAt: true } },
    },
  });

  const members: MemberInput[] = contracts.map((c) => ({
    createdAt: c.treatmentStartedAt ?? c.createdAt,
    cancelledAt: effectiveCancelledAt(c),
    cancelReason: c.cancelReason,
    status: c.status,
    successfulOrders: c.successfulOrders,
    intervalWeeks: c.intervalWeeks,
    widgetVersion: c.widgetVersion,
    dunningPhase: c.dunningState?.phase ?? null,
    dunningGraceUntil: c.dunningState?.graceUntil ?? null,
    dunningUpdatedAt: c.dunningState?.updatedAt ?? null,
  }));

  const curves: SurvivalCurve[] = [toCurve("all", members, now)];

  if (cohortBy) {
    const groups = new Map<string, MemberInput[]>();
    for (const member of members) {
      const key = groupKeyFor(member, cohortBy);
      const list = groups.get(key);
      if (list) list.push(member);
      else groups.set(key, [member]);
    }
    const sortedKeys = sortCohortKeys([...groups.keys()], cohortBy).slice(
      0,
      MAX_COHORT_CURVES,
    );
    for (const key of sortedKeys) {
      curves.push(toCurve(key, groups.get(key) ?? [], now));
    }
  }

  return curves;
}
