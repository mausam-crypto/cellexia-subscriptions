/**
 * Routines — graduated routine expansion and contract consolidation.
 *
 * recommendRoutine picks the RoutineTemplate for a concern, subtracts what the
 * customer already owns, validates the combination with routineCoherence and
 * returns ordered steps + add suggestions + stagger warnings (brand voice).
 *
 * consolidationPlan proposes merging a customer's multiple ACTIVE contracts
 * into the one with the soonest nextBillingDate (fewest shipments). It only
 * proposes — executing the merge is core's mergeContracts.
 */
import prisma from "~/db.server";
import {
  getGraphForProducts,
  routineCoherence,
} from "~/services/treatment/compatibility.server";
import { parseJson } from "~/types/domain";
import type { TimeOfDay } from "~/types/domain";
import type { RoutineTemplate } from "@prisma/client";

export interface RoutineStep {
  productId: string;
  role?: string;
  timeOfDay?: TimeOfDay;
  optional?: boolean;
}

export interface RoutineSuggestion extends RoutineStep {
  title: string | null;
}

export interface StaggerWarning {
  productIds: [string, string];
  message: string;
}

export interface RoutineRecommendation {
  template: RoutineTemplate | null;
  /** Template steps in application order (topological + AM/PM). */
  steps: RoutineStep[];
  /** Steps the customer doesn't own yet, filtered for conflicts/availability. */
  addSuggestions: RoutineSuggestion[];
  staggerWarnings: StaggerWarning[];
}

export async function recommendRoutine(
  shop: string,
  params: { concern: string; currentProductIds: string[] },
): Promise<RoutineRecommendation> {
  const template = await prisma.routineTemplate.findFirst({
    where: { shop, concern: params.concern, active: true },
    orderBy: { updatedAt: "desc" },
  });
  if (!template) {
    return { template: null, steps: [], addSuggestions: [], staggerWarnings: [] };
  }

  const steps = parseJson<RoutineStep[]>(template.stepsJson, []).filter(
    (s): s is RoutineStep => Boolean(s) && typeof s.productId === "string",
  );
  const owned = new Set(params.currentProductIds);
  const allIds = [
    ...new Set([...steps.map((s) => s.productId), ...params.currentProductIds]),
  ];

  const [metas, graph] = await Promise.all([
    prisma.productMeta.findMany({
      where: { shop, shopifyProductId: { in: allIds } },
    }),
    getGraphForProducts(shop, allIds),
  ]);
  const metaById = new Map(metas.map((m) => [m.shopifyProductId, m]));
  const timeOfDayMap: Record<string, TimeOfDay> = {};
  for (const m of metas) timeOfDayMap[m.shopifyProductId] = m.timeOfDay as TimeOfDay;

  const coherence = routineCoherence(allIds, graph.edges, timeOfDayMap);
  const orderIndex = new Map(coherence.order.map((id, i) => [id, i]));
  const orderedSteps = [...steps].sort(
    (a, b) =>
      (orderIndex.get(a.productId) ?? Number.MAX_SAFE_INTEGER) -
      (orderIndex.get(b.productId) ?? Number.MAX_SAFE_INTEGER),
  );

  // Never suggest a product that conflicts with something the customer owns.
  const conflictsWithOwned = (id: string): boolean =>
    coherence.conflicts.some(
      (c) => (c.a === id && owned.has(c.b)) || (c.b === id && owned.has(c.a)),
    );

  const addSuggestions: RoutineSuggestion[] = orderedSteps
    .filter((s) => !owned.has(s.productId))
    .filter((s) => {
      const meta = metaById.get(s.productId);
      return !meta || (meta.subscribable && meta.active);
    })
    .filter((s) => !conflictsWithOwned(s.productId))
    .map((s) => ({ ...s, title: metaById.get(s.productId)?.title ?? null }));

  const titleOf = (id: string): string => metaById.get(id)?.title ?? "this product";
  const staggerWarnings: StaggerWarning[] = coherence.staggers.map((pair) => ({
    productIds: [pair.a, pair.b],
    message: `Introduce ${titleOf(pair.a)} and ${titleOf(
      pair.b,
    )} on alternating days to begin with — your skin will settle into the routine gently.`,
  }));

  return { template, steps: orderedSteps, addSuggestions, staggerWarnings };
}

/**
 * If a customer has more than one ACTIVE contract, propose merging everything
 * into the contract with the soonest nextBillingDate — the customer keeps the
 * delivery they are already expecting and ships fewer boxes overall.
 */
export async function consolidationPlan(
  shop: string,
  shopifyCustomerId: string,
): Promise<{ merge: boolean; targetContractId?: string; sourceContractIds: string[] }> {
  const contracts = await prisma.subscriptionContract.findMany({
    where: { shop, shopifyCustomerId, status: "ACTIVE" },
  });
  if (contracts.length < 2) {
    return { merge: false, sourceContractIds: [] };
  }
  const sorted = [...contracts].sort((a, b) => {
    const at = a.nextBillingDate?.getTime() ?? Number.POSITIVE_INFINITY;
    const bt = b.nextBillingDate?.getTime() ?? Number.POSITIVE_INFINITY;
    return at - bt;
  });
  const [target, ...sources] = sorted;
  return {
    merge: true,
    targetContractId: target.id,
    sourceContractIds: sources.map((c) => c.id),
  };
}
