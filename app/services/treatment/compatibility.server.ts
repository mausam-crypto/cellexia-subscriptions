/**
 * Product compatibility graph.
 *
 * Directed edges between Shopify products with a relation from
 * ~/types/domain COMPATIBILITY_RELATIONS:
 * - PAIRS_WITH            products reinforce each other (cross-sell signal)
 * - STAGGER               introduce a few days apart (warning, not a blocker)
 * - REDUNDANT             overlapping actives — don't recommend both
 * - ROUTINE_STEP_BEFORE   from-product is applied before to-product
 * - SENSITIVITY_CONFLICT  never combine in one routine (hard conflict)
 *
 * routineCoherence is pure (no I/O) so it is unit-testable
 * (tests/treatment/routines.test.ts).
 */
import prisma from "~/db.server";
import { appendAudit } from "~/services/audit.server";
import { COMPATIBILITY_RELATIONS } from "~/types/domain";
import type { CompatibilityRelation, TimeOfDay } from "~/types/domain";
import type { CompatibilityEdge } from "@prisma/client";

// ─────────────────────────────── CRUD helpers ─────────────────────────────

export interface EdgeInput {
  fromProductId: string;
  toProductId: string;
  relation: CompatibilityRelation;
  strength?: number;
  notes?: string | null;
}

/** Create or update an edge (unique per shop+from+to+relation). */
export async function upsertEdge(
  shop: string,
  edge: EdgeInput,
  actorId?: string,
): Promise<CompatibilityEdge> {
  if (!(COMPATIBILITY_RELATIONS as readonly string[]).includes(edge.relation)) {
    throw new Error(`upsertEdge: unknown relation ${edge.relation}`);
  }
  if (!edge.fromProductId || !edge.toProductId || edge.fromProductId === edge.toProductId) {
    throw new Error("upsertEdge: fromProductId and toProductId must differ and be set");
  }
  const strength = edge.strength ?? 1;
  const saved = await prisma.compatibilityEdge.upsert({
    where: {
      shop_fromProductId_toProductId_relation: {
        shop,
        fromProductId: edge.fromProductId,
        toProductId: edge.toProductId,
        relation: edge.relation,
      },
    },
    create: {
      shop,
      fromProductId: edge.fromProductId,
      toProductId: edge.toProductId,
      relation: edge.relation,
      strength,
      notes: edge.notes ?? null,
    },
    update: { strength, notes: edge.notes ?? null },
  });
  await appendAudit({
    shop,
    actorType: actorId ? "STAFF" : "SYSTEM",
    actorId: actorId ?? null,
    action: "COMPATIBILITY_EDGE_UPSERT",
    subjectType: "CompatibilityEdge",
    subjectId: saved.id,
    payload: {
      fromProductId: edge.fromProductId,
      toProductId: edge.toProductId,
      relation: edge.relation,
      strength,
    },
  });
  return saved;
}

export async function deleteEdge(
  shop: string,
  edgeId: string,
  actorId?: string,
): Promise<void> {
  const edge = await prisma.compatibilityEdge.findUnique({ where: { id: edgeId } });
  if (!edge || edge.shop !== shop) {
    throw new Error(`deleteEdge: edge not found: ${edgeId}`);
  }
  await prisma.compatibilityEdge.delete({ where: { id: edgeId } });
  await appendAudit({
    shop,
    actorType: actorId ? "STAFF" : "SYSTEM",
    actorId: actorId ?? null,
    action: "COMPATIBILITY_EDGE_DELETED",
    subjectType: "CompatibilityEdge",
    subjectId: edgeId,
    payload: {
      fromProductId: edge.fromProductId,
      toProductId: edge.toProductId,
      relation: edge.relation,
    },
  });
}

export interface AdjacentRelation {
  productId: string;
  relation: CompatibilityRelation;
  /** OUT: edge points from the keyed product; IN: edge points to it. */
  direction: "OUT" | "IN";
  strength: number;
}

/**
 * Load the sub-graph touching any of the given products, as raw edges plus
 * an adjacency map keyed by product id.
 */
export async function getGraphForProducts(
  shop: string,
  productIds: string[],
): Promise<{ edges: CompatibilityEdge[]; adjacency: Record<string, AdjacentRelation[]> }> {
  if (productIds.length === 0) return { edges: [], adjacency: {} };
  const edges = await prisma.compatibilityEdge.findMany({
    where: {
      shop,
      OR: [
        { fromProductId: { in: productIds } },
        { toProductId: { in: productIds } },
      ],
    },
  });
  const adjacency: Record<string, AdjacentRelation[]> = {};
  for (const id of productIds) adjacency[id] = [];
  for (const e of edges) {
    const relation = e.relation as CompatibilityRelation;
    if (adjacency[e.fromProductId]) {
      adjacency[e.fromProductId].push({
        productId: e.toProductId,
        relation,
        direction: "OUT",
        strength: e.strength,
      });
    }
    if (adjacency[e.toProductId]) {
      adjacency[e.toProductId].push({
        productId: e.fromProductId,
        relation,
        direction: "IN",
        strength: e.strength,
      });
    }
  }
  return { edges, adjacency };
}

// ─────────────────────────────── Pure coherence ───────────────────────────

/** Structural subset of a CompatibilityEdge — Prisma rows satisfy this. */
export interface CoherenceEdge {
  fromProductId: string;
  toProductId: string;
  relation: string;
}

export interface ProductPair {
  a: string;
  b: string;
}

export interface CoherenceResult {
  /** False when the set contains at least one SENSITIVITY_CONFLICT pair. */
  coherent: boolean;
  conflicts: ProductPair[];
  redundancies: ProductPair[];
  /** Pairs that should be introduced a few days apart (warning only). */
  staggers: ProductPair[];
  /**
   * productIds ordered for application: topological order over
   * ROUTINE_STEP_BEFORE edges, tie-broken by time of day (AM < BOTH < PM)
   * and then by input order. Cycles fall back to the tie-break order.
   */
  order: string[];
}

/**
 * Pure routine-coherence check over a set of products and the edges between
 * them. Edges touching products outside the set are ignored.
 */
export function routineCoherence(
  productIds: string[],
  edges: CoherenceEdge[],
  timeOfDay: Record<string, TimeOfDay> = {},
): CoherenceResult {
  const ids = [...new Set(productIds)];
  const inSet = new Set(ids);
  const internal = edges.filter(
    (e) =>
      inSet.has(e.fromProductId) &&
      inSet.has(e.toProductId) &&
      e.fromProductId !== e.toProductId,
  );

  const conflicts: ProductPair[] = [];
  const redundancies: ProductPair[] = [];
  const staggers: ProductPair[] = [];
  const before: Array<[string, string]> = [];
  const seenPairs = new Set<string>();

  const pushPair = (bucket: ProductPair[], e: CoherenceEdge) => {
    const key = [e.relation, ...[e.fromProductId, e.toProductId].sort()].join("|");
    if (seenPairs.has(key)) return;
    seenPairs.add(key);
    bucket.push({ a: e.fromProductId, b: e.toProductId });
  };

  for (const e of internal) {
    switch (e.relation) {
      case "SENSITIVITY_CONFLICT":
        pushPair(conflicts, e);
        break;
      case "REDUNDANT":
        pushPair(redundancies, e);
        break;
      case "STAGGER":
        pushPair(staggers, e);
        break;
      case "ROUTINE_STEP_BEFORE":
        before.push([e.fromProductId, e.toProductId]);
        break;
      default:
        break; // PAIRS_WITH carries no coherence constraint
    }
  }

  // Ordering: Kahn's topological sort over ROUTINE_STEP_BEFORE, choosing the
  // ready node with the smallest (timeBucket, inputIndex).
  const index = new Map<string, number>(ids.map((id, i) => [id, i]));
  const bucketOf = (id: string): number => {
    const t = timeOfDay[id] ?? "BOTH";
    return t === "AM" ? 0 : t === "PM" ? 2 : 1;
  };
  const compare = (a: string, b: string): number =>
    bucketOf(a) - bucketOf(b) || (index.get(a) ?? 0) - (index.get(b) ?? 0);

  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const outEdges = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [from, to] of before) {
    outEdges.get(from)?.push(to);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }

  const remaining = new Set(ids);
  const order: string[] = [];
  while (remaining.size > 0) {
    let pick: string | null = null;
    for (const id of remaining) {
      if ((indegree.get(id) ?? 0) > 0) continue;
      if (pick === null || compare(id, pick) < 0) pick = id;
    }
    if (pick === null) {
      // Cycle in ROUTINE_STEP_BEFORE data — fall back to tie-break order.
      order.push(...[...remaining].sort(compare));
      break;
    }
    remaining.delete(pick);
    order.push(pick);
    for (const to of outEdges.get(pick) ?? []) {
      indegree.set(to, (indegree.get(to) ?? 0) - 1);
    }
  }

  return {
    coherent: conflicts.length === 0,
    conflicts,
    redundancies,
    staggers,
    order,
  };
}
