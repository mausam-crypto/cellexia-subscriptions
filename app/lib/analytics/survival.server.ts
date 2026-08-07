import prisma from "~/db.server";
import { COUNTABLE_CONTRACT } from "./queries.server";

/**
 * Survival-by-cycle curves from the ordersCount distribution — a life-table
 * (Kaplan-Meier) estimator, NOT a raw share-of-book distribution.
 *
 * Why: on a young book, most contracts simply have not reached cycle N yet.
 * The naive estimate "contracts with ordersCount ≥ N ÷ all contracts" counts
 * every one of them as a cycle-N failure, so a healthy 6-month-old book reads
 * "40% churned by cycle 1" when literally nobody churned — and the forecast,
 * which derives per-cycle retention from these ratios, then projects losing
 * most of the base. Right-censoring must be handled:
 *
 * - A contract that CHURNED with ordersCount = k died in the interval k → k+1.
 * - A live (ACTIVE/PAUSED) contract with ordersCount = k is CENSORED at k: it
 *   reached cycle k and its fate beyond is simply unknown — it belongs in no
 *   denominator past k.
 *
 * Life table: for the transition k−1 → k, the at-risk set n_k is contracts
 * that reached cycle k PLUS churners who died in that interval; the deaths d_k
 * are churners with ordersCount = k−1. S(n) = Π_{k≤n} (1 − d_k / n_k).
 *
 * Churn classification:
 * - involuntary: CANCELLED with cancelSource DUNNING, or status FAILED
 *   (dunning ladder exhausted under the default PAUSE action — no cancelledAt
 *   ever exists, which previously made payment churn invisible here).
 * - voluntary: every other terminal state (CANCELLED with CUSTOMER / ADMIN /
 *   SYSTEM / unknown source, and EXPIRED).
 * The cause-specific curves treat only their own cause as death (standard
 * cause-specific hazard, same at-risk sets), so the gap each curve leaves
 * below 100% is that cause's cumulative damage.
 */

/** Cap so a single ancient contract doesn't produce a 100-point curve. */
const MAX_CYCLES = 36;

/** Statuses that mean the subscription is over (churn events for survival). */
const TERMINAL_STATUSES = new Set(["CANCELLED", "FAILED", "EXPIRED"]);

export interface SurvivalCurves {
  /** Cycle numbers 1..maxCycle (parallel to the three fraction arrays). */
  cycles: number[];
  /** overall[i] = Kaplan-Meier estimate of P(survive to cycle cycles[i]). */
  overall: number[];
  /** Cause-specific curve counting only voluntary churn as death. */
  voluntary: number[];
  /** Cause-specific curve counting only involuntary (payment) churn as death. */
  involuntary: number[];
  totalContracts: number;
}

/**
 * Fraction of contracts reaching each billing cycle (censoring-corrected),
 * with the churn cause decomposed: the voluntary curve treats only
 * non-payment churn as death, the involuntary curve only payment churn — so
 * (1 − voluntary[n]) + (1 − involuntary[n]) ≈ total churn before cycle n.
 *
 * The forecast derives per-cycle retention from ratios of `overall`, so this
 * estimator feeds it unbiased hazards even on a young book (a brand-new book
 * with zero observed transitions yields a flat 100% curve, not 0%).
 */
export async function getSurvivalByCycle(shopId: string): Promise<SurvivalCurves> {
  const groups = await prisma.subscriptionContract.groupBy({
    by: ["ordersCount", "status", "cancelSource"],
    where: { shopId, ...COUNTABLE_CONTRACT },
    _count: { _all: true },
  });

  const totalContracts = groups.reduce((sum, g) => sum + g._count._all, 0);
  if (totalContracts === 0) {
    return { cycles: [], overall: [], voluntary: [], involuntary: [], totalContracts: 0 };
  }

  const maxObserved = groups.reduce((max, g) => Math.max(max, g.ordersCount), 0);
  const maxCycle = Math.min(Math.max(1, maxObserved), MAX_CYCLES);

  // Histograms indexed by ordersCount (clamped to maxCycle for the tail).
  const reachedHist = new Array<number>(maxCycle + 1).fill(0); // everyone, by cycles reached
  const volDeathHist = new Array<number>(maxCycle + 1).fill(0); // voluntary churners, by last cycle
  const invDeathHist = new Array<number>(maxCycle + 1).fill(0); // involuntary churners, by last cycle
  for (const g of groups) {
    const bucket = Math.min(g.ordersCount, maxCycle);
    reachedHist[bucket] += g._count._all;
    if (!TERMINAL_STATUSES.has(g.status)) continue;
    const isInvoluntary =
      g.status === "FAILED" ||
      (g.status === "CANCELLED" && g.cancelSource === "DUNNING");
    if (isInvoluntary) invDeathHist[bucket] += g._count._all;
    else volDeathHist[bucket] += g._count._all;
  }

  // Suffix sums: reachedAtLeast[k] = contracts with ordersCount ≥ k.
  const reachedAtLeast = new Array<number>(maxCycle + 2).fill(0);
  for (let k = maxCycle; k >= 0; k--) {
    reachedAtLeast[k] = reachedAtLeast[k + 1] + reachedHist[k];
  }

  const cycles: number[] = [];
  const overall: number[] = [];
  const voluntary: number[] = [];
  const involuntary: number[] = [];

  let sAll = 1;
  let sVol = 1;
  let sInv = 1;
  for (let n = 1; n <= maxCycle; n++) {
    const dVol = volDeathHist[n - 1];
    const dInv = invDeathHist[n - 1];
    const deaths = dVol + dInv;
    // At risk for the (n−1 → n) transition: contracts that made it to n, plus
    // those that died trying. Censored-at-(n−1) live contracts are excluded —
    // they never had the chance to renew.
    const atRisk = reachedAtLeast[n] + deaths;
    if (atRisk > 0) {
      sAll *= 1 - deaths / atRisk;
      sVol *= 1 - dVol / atRisk;
      sInv *= 1 - dInv / atRisk;
    }
    // atRisk === 0 → no information at this depth; hazards stay 0 (S carries).
    cycles.push(n);
    overall.push(round4(sAll));
    voluntary.push(round4(sVol));
    involuntary.push(round4(sInv));
  }

  return { cycles, overall, voluntary, involuntary, totalContracts };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
