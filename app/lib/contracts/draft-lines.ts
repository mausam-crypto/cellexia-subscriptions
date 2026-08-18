/**
 * Pure resolver shared by every billing-cycle-edit writer (per-line skip /
 * undo / quantity tweak in contracts/service.server.ts, DiscountGrant
 * application in billing/discounts.server.ts, whole-cycle skip/unskip
 * restores): the draft line a mirrored contract line acts on. Prefer the
 * contract line's own id (what a fresh cycle draft carries); after an unskip
 * the cycle holds a RE-ADDED copy under a cycle-scoped id, so fall back to
 * the draft line with the same variant that is not another mirrored line's
 * id. Null when the line is not on the draft at all (skipped by an earlier
 * edit) — a writer must then leave it out rather than update a stale id,
 * which would fail the whole edit (v1.28.0 review fix). No I/O; lives
 * outside the graphql layer so tests that mock that layer still exercise it.
 */

export interface DraftLineLike {
  id: string;
  variantId: string | null;
  quantity: number;
}

export function matchDraftLine<T extends DraftLineLike>(
  lines: readonly T[],
  mirroredLines: ReadonlyArray<{ id: string; shopifyLineId: string | null }>,
  line: { id: string; shopifyLineId: string; variantId: string },
): T | null {
  const exact = lines.find((d) => d.id === line.shopifyLineId);
  if (exact) return exact;
  const otherIds = new Set(
    mirroredLines
      .filter((l) => l.id !== line.id && l.shopifyLineId)
      .map((l) => l.shopifyLineId as string),
  );
  return (
    lines.find((d) => d.variantId === line.variantId && !otherIds.has(d.id)) ??
    null
  );
}
