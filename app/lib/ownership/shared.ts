/**
 * Ownership vocabulary — the pure, isomorphic half of
 * `~/lib/ownership/ownership.server`.
 *
 * These constants and helpers are referenced by admin route COMPONENTS
 * (ownership filter options, badge labels, guard messages), so they must be
 * importable by the client bundle. Everything here is a constant or a pure
 * function: no prisma, no node builtins, no Shopify client, no other .server
 * import — and it must stay that way, or the production build breaks again
 * with "Server-only module referenced by client".
 *
 * Server code keeps importing these names from
 * `~/lib/ownership/ownership.server`, which re-exports this module verbatim;
 * there is exactly one definition of each. See ownership.server.ts for the
 * full story of WHY ownership exists (competitor app on the same store,
 * duplicate-charge hazard, fail-safe direction).
 */

// ── Vocabulary ───────────────────────────────────────────────────────────────

export const OWNERSHIP_OURS = "OURS";
export const OWNERSHIP_FOREIGN = "FOREIGN";
export const OWNERSHIP_UNKNOWN = "UNKNOWN";

export type ContractOwnership =
  | typeof OWNERSHIP_OURS
  | typeof OWNERSHIP_FOREIGN
  | typeof OWNERSHIP_UNKNOWN;

/**
 * The `where` fragment every query that bills, messages, analyses or exposes a
 * contract must spread. Import this instead of writing the string inline so a
 * future rename cannot miss a call site.
 */
export const OURS_ONLY = { ownership: OWNERSHIP_OURS } as const;

/** Is this ownership value allowed to be billed / messaged / counted? */
export function isBillableOwnership(value: string | null | undefined): boolean {
  return value === OWNERSHIP_OURS;
}

export function normalizeOwnership(
  value: string | null | undefined,
): ContractOwnership | null {
  if (value === OWNERSHIP_OURS) return OWNERSHIP_OURS;
  if (value === OWNERSHIP_FOREIGN) return OWNERSHIP_FOREIGN;
  if (value === OWNERSHIP_UNKNOWN) return OWNERSHIP_UNKNOWN;
  return null;
}
