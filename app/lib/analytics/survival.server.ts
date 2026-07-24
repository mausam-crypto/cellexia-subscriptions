import prisma from "~/db.server";

/**
 * Survival-by-cycle curves from the ordersCount distribution.
 *
 * ordersCount = successful cycles billed, so "reached cycle N" means
 * ordersCount ≥ N. This is the simple distribution estimate the spec asks
 * for: active contracts that haven't yet reached cycle N count as not having
 * reached it (right-censoring is NOT corrected — young books will understate
 * deep-cycle survival slightly; acceptable for the admin chart).
 */

/** Cap so a single ancient contract doesn't produce a 100-point curve. */
const MAX_CYCLES = 36;

export interface SurvivalCurves {
  /** Cycle numbers 1..maxCycle (parallel to the three fraction arrays). */
  cycles: number[];
  /** overall[i] = contracts with ordersCount ≥ cycles[i] ÷ totalContracts. */
  overall: number[];
  /**
   * voluntary[i] = 1 − (voluntary churners with ordersCount < cycles[i]) ÷ total.
   * "Voluntary" = CANCELLED with cancelSource ≠ DUNNING (CUSTOMER, ADMIN,
   * SYSTEM and unknown sources are grouped as voluntary).
   */
  voluntary: number[];
  /** involuntary[i] = 1 − (DUNNING churners with ordersCount < cycles[i]) ÷ total. */
  involuntary: number[];
  totalContracts: number;
}

/**
 * Fraction of contracts reaching each billing cycle, with the churn cause
 * decomposed: the voluntary curve treats only non-dunning cancels as deaths,
 * the involuntary curve only dunning cancels — so (1 − voluntary[n]) +
 * (1 − involuntary[n]) ≈ total churn before cycle n.
 */
export async function getSurvivalByCycle(shopId: string): Promise<SurvivalCurves> {
  const groups = await prisma.subscriptionContract.groupBy({
    by: ["ordersCount", "status", "cancelSource"],
    where: { shopId, isDemo: false },
    _count: { _all: true },
  });

  const totalContracts = groups.reduce((sum, g) => sum + g._count._all, 0);
  if (totalContracts === 0) {
    return { cycles: [], overall: [], voluntary: [], involuntary: [], totalContracts: 0 };
  }

  const maxObserved = groups.reduce((max, g) => Math.max(max, g.ordersCount), 0);
  const maxCycle = Math.min(Math.max(1, maxObserved), MAX_CYCLES);

  // Histograms indexed by ordersCount (clamped to maxCycle for the tail).
  const allHist = new Array<number>(maxCycle + 1).fill(0);
  const volHist = new Array<number>(maxCycle + 1).fill(0);
  const invHist = new Array<number>(maxCycle + 1).fill(0);
  for (const g of groups) {
    const bucket = Math.min(g.ordersCount, maxCycle);
    allHist[bucket] += g._count._all;
    if (g.status === "CANCELLED") {
      if (g.cancelSource === "DUNNING") invHist[bucket] += g._count._all;
      else volHist[bucket] += g._count._all;
    }
  }

  const cycles: number[] = [];
  const overall: number[] = [];
  const voluntary: number[] = [];
  const involuntary: number[] = [];

  let reachedBelow = 0; // contracts with ordersCount < n
  let volBelow = 0; // voluntary churners with ordersCount < n
  let invBelow = 0; // involuntary churners with ordersCount < n
  for (let n = 1; n <= maxCycle; n++) {
    reachedBelow += allHist[n - 1];
    volBelow += volHist[n - 1];
    invBelow += invHist[n - 1];
    cycles.push(n);
    overall.push(round4((totalContracts - reachedBelow) / totalContracts));
    voluntary.push(round4((totalContracts - volBelow) / totalContracts));
    involuntary.push(round4((totalContracts - invBelow) / totalContracts));
  }

  return { cycles, overall, voluntary, involuntary, totalContracts };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
