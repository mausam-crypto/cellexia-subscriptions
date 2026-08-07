/**
 * Compound (createdAt, id) keyset pagination — shared by the audit log and
 * the subscribers list.
 *
 * A bare createdAt cursor with strict lt/gt silently loses rows: createdAt is
 * timestamp(3), and a webhook burst or bulk operation writes several rows in
 * the SAME millisecond. When page 1 ends mid-tie at time T, "next" asks for
 * createdAt < T and every remaining row at exactly T never appears on any
 * page — an auditor paging a compliance log misses events with no indication.
 * Worse, with orderBy on createdAt alone, equal-timestamp rows may swap order
 * between the page-1 and page-2 queries, duplicating/skipping rows even
 * without a boundary tie.
 *
 * The fix is a total order: ORDER BY (createdAt, id) with a cursor carrying
 * both keys, and the boundary condition
 *   (createdAt < c.at) OR (createdAt = c.at AND id < c.id)
 * (mirrored for "prev"). `id` is a cuid — unique, so the order is strict; its
 * lexicographic direction within one millisecond is arbitrary but STABLE,
 * which is all keyset pagination needs.
 *
 * Cursor wire format: "<createdAt ISO>~<id>". A legacy bare-ISO cursor (an
 * old tab's link) still decodes — with no id, the conditions degrade to the
 * old strict timestamp comparison for that one request, and every link the
 * response emits carries the compound format.
 */

export interface CreatedIdCursor {
  at: Date;
  /** Null only for legacy bare-timestamp cursors. */
  id: string | null;
}

export function encodeCreatedIdCursor(row: {
  createdAt: Date;
  id: string;
}): string {
  return `${row.createdAt.toISOString()}~${row.id}`;
}

export function decodeCreatedIdCursor(
  raw: string | null,
): CreatedIdCursor | null {
  if (!raw) return null;
  const sep = raw.indexOf("~");
  const isoPart = sep === -1 ? raw : raw.slice(0, sep);
  const idPart = sep === -1 ? null : raw.slice(sep + 1);
  const at = new Date(isoPart);
  if (Number.isNaN(at.getTime())) return null;
  return { at, id: idPart && idPart.length > 0 ? idPart : null };
}

/** Rows strictly AFTER the cursor in (createdAt desc, id desc) page order. */
export function createdIdAfter(cursor: CreatedIdCursor): Record<string, unknown> {
  if (cursor.id == null) return { createdAt: { lt: cursor.at } };
  return {
    OR: [
      { createdAt: { lt: cursor.at } },
      { createdAt: cursor.at, id: { lt: cursor.id } },
    ],
  };
}

/** Rows strictly BEFORE the cursor in (createdAt desc, id desc) page order. */
export function createdIdBefore(cursor: CreatedIdCursor): Record<string, unknown> {
  if (cursor.id == null) return { createdAt: { gt: cursor.at } };
  return {
    OR: [
      { createdAt: { gt: cursor.at } },
      { createdAt: cursor.at, id: { gt: cursor.id } },
    ],
  };
}

/** Total page order, newest first. */
export const CREATED_ID_DESC = [
  { createdAt: "desc" },
  { id: "desc" },
] as const;

/** Reverse scan for "prev" pages (caller reverses the slice back). */
export const CREATED_ID_ASC = [{ createdAt: "asc" }, { id: "asc" }] as const;
