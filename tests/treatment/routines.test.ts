import { describe, expect, it, vi } from "vitest";

// Keep the unit tests free of a real Prisma client — only pure exports are used.
vi.mock("~/db.server", () => ({ default: {} }));

import { routineCoherence } from "~/services/treatment/compatibility.server";
import type { CoherenceEdge } from "~/services/treatment/compatibility.server";

const CLEANSER = "gid://shopify/Product/1";
const SERUM = "gid://shopify/Product/2";
const MOISTURIZER = "gid://shopify/Product/3";
const RETINOL = "gid://shopify/Product/4";
const ACID = "gid://shopify/Product/5";

describe("routineCoherence — ordering", () => {
  it("orders by ROUTINE_STEP_BEFORE regardless of input order", () => {
    const edges: CoherenceEdge[] = [
      { fromProductId: CLEANSER, toProductId: SERUM, relation: "ROUTINE_STEP_BEFORE" },
      { fromProductId: SERUM, toProductId: MOISTURIZER, relation: "ROUTINE_STEP_BEFORE" },
    ];
    const result = routineCoherence([MOISTURIZER, CLEANSER, SERUM], edges);
    expect(result.order).toEqual([CLEANSER, SERUM, MOISTURIZER]);
    expect(result.coherent).toBe(true);
  });

  it("breaks ties by time of day: AM before BOTH before PM", () => {
    const result = routineCoherence([RETINOL, SERUM, CLEANSER], [], {
      [RETINOL]: "PM",
      [SERUM]: "BOTH",
      [CLEANSER]: "AM",
    });
    expect(result.order).toEqual([CLEANSER, SERUM, RETINOL]);
  });

  it("lets step-before constraints win over time-of-day tie-breaks", () => {
    const edges: CoherenceEdge[] = [
      { fromProductId: RETINOL, toProductId: CLEANSER, relation: "ROUTINE_STEP_BEFORE" },
    ];
    const result = routineCoherence([CLEANSER, RETINOL], edges, {
      [RETINOL]: "PM",
      [CLEANSER]: "AM",
    });
    expect(result.order).toEqual([RETINOL, CLEANSER]);
  });

  it("survives cycles in step-before data with a stable fallback order", () => {
    const edges: CoherenceEdge[] = [
      { fromProductId: CLEANSER, toProductId: SERUM, relation: "ROUTINE_STEP_BEFORE" },
      { fromProductId: SERUM, toProductId: CLEANSER, relation: "ROUTINE_STEP_BEFORE" },
    ];
    const result = routineCoherence([CLEANSER, SERUM], edges);
    expect(result.order).toHaveLength(2);
    expect(new Set(result.order)).toEqual(new Set([CLEANSER, SERUM]));
  });

  it("deduplicates repeated product ids", () => {
    const result = routineCoherence([CLEANSER, CLEANSER, SERUM], []);
    expect(result.order).toEqual([CLEANSER, SERUM]);
  });
});

describe("routineCoherence — conflicts, redundancies, staggers", () => {
  it("flags SENSITIVITY_CONFLICT pairs and marks the set incoherent", () => {
    const edges: CoherenceEdge[] = [
      { fromProductId: RETINOL, toProductId: ACID, relation: "SENSITIVITY_CONFLICT" },
    ];
    const result = routineCoherence([RETINOL, ACID], edges);
    expect(result.coherent).toBe(false);
    expect(result.conflicts).toEqual([{ a: RETINOL, b: ACID }]);
  });

  it("lists redundancies without breaking coherence", () => {
    const edges: CoherenceEdge[] = [
      { fromProductId: SERUM, toProductId: ACID, relation: "REDUNDANT" },
    ];
    const result = routineCoherence([SERUM, ACID], edges);
    expect(result.coherent).toBe(true);
    expect(result.redundancies).toEqual([{ a: SERUM, b: ACID }]);
  });

  it("lists staggers as warnings without breaking coherence", () => {
    const edges: CoherenceEdge[] = [
      { fromProductId: RETINOL, toProductId: SERUM, relation: "STAGGER" },
    ];
    const result = routineCoherence([RETINOL, SERUM], edges);
    expect(result.coherent).toBe(true);
    expect(result.staggers).toEqual([{ a: RETINOL, b: SERUM }]);
  });

  it("ignores edges touching products outside the set", () => {
    const edges: CoherenceEdge[] = [
      { fromProductId: RETINOL, toProductId: ACID, relation: "SENSITIVITY_CONFLICT" },
      { fromProductId: CLEANSER, toProductId: ACID, relation: "ROUTINE_STEP_BEFORE" },
    ];
    const result = routineCoherence([RETINOL, CLEANSER], edges);
    expect(result.coherent).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  it("deduplicates mirrored pair edges", () => {
    const edges: CoherenceEdge[] = [
      { fromProductId: RETINOL, toProductId: ACID, relation: "SENSITIVITY_CONFLICT" },
      { fromProductId: ACID, toProductId: RETINOL, relation: "SENSITIVITY_CONFLICT" },
    ];
    const result = routineCoherence([RETINOL, ACID], edges);
    expect(result.conflicts).toHaveLength(1);
  });

  it("treats PAIRS_WITH as neutral for coherence", () => {
    const edges: CoherenceEdge[] = [
      { fromProductId: SERUM, toProductId: MOISTURIZER, relation: "PAIRS_WITH" },
    ];
    const result = routineCoherence([SERUM, MOISTURIZER], edges);
    expect(result.coherent).toBe(true);
    expect(result.conflicts).toHaveLength(0);
    expect(result.redundancies).toHaveLength(0);
    expect(result.staggers).toHaveLength(0);
  });
});
