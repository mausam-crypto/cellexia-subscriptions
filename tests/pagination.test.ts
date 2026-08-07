import { describe, expect, it } from "vitest";
import { matchesWhere, type Row } from "./helpers/analytics-db";
import {
  CREATED_ID_ASC,
  CREATED_ID_DESC,
  createdIdAfter,
  createdIdBefore,
  decodeCreatedIdCursor,
  encodeCreatedIdCursor,
} from "~/lib/pagination.server";

/**
 * Compound (createdAt, id) keyset pagination — the audit-log/subscribers fix.
 *
 * The defect: a bare createdAt cursor with strict lt/gt loses every row that
 * shares the boundary MILLISECOND with the page break (createdAt is
 * timestamp(3), and webhook bursts write several SubscriberEvents in one ms),
 * and a single-key orderBy lets equal-timestamp rows swap order between the
 * page-1 and page-2 queries. An auditor paging the compliance log silently
 * missed events.
 *
 * The walk below drives the REAL cursor conditions through the same where-
 * clause interpreter the analytics golden tests use, over a fixture dense
 * with millisecond ties — so a dropped OR leg or a broken tiebreak surfaces
 * as a skipped or duplicated row, exactly like production.
 */

const T0 = new Date("2026-08-06T10:00:00.000Z").getTime();

/** 11 rows, deliberately clustered: 4 share t+1ms, 3 share t+3ms. */
const ROWS: Array<{ id: string; createdAt: Date }> = [
  { id: "a1", createdAt: new Date(T0) },
  { id: "b1", createdAt: new Date(T0 + 1) },
  { id: "b2", createdAt: new Date(T0 + 1) },
  { id: "b3", createdAt: new Date(T0 + 1) },
  { id: "b4", createdAt: new Date(T0 + 1) },
  { id: "c1", createdAt: new Date(T0 + 2) },
  { id: "d1", createdAt: new Date(T0 + 3) },
  { id: "d2", createdAt: new Date(T0 + 3) },
  { id: "d3", createdAt: new Date(T0 + 3) },
  { id: "e1", createdAt: new Date(T0 + 4) },
  { id: "f1", createdAt: new Date(T0 + 5) },
];

type SortSpec = ReadonlyArray<{ [k: string]: "asc" | "desc" }>;

function sortBy(rows: typeof ROWS, specs: SortSpec): typeof ROWS {
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      for (const [field, dir] of Object.entries(spec)) {
        const av = a[field as keyof typeof a];
        const bv = b[field as keyof typeof b];
        const ao = av instanceof Date ? av.getTime() : (av as string);
        const bo = bv instanceof Date ? bv.getTime() : (bv as string);
        const cmp = ao < bo ? -1 : ao > bo ? 1 : 0;
        if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
      }
    }
    return 0;
  });
}

/** One "next" page exactly as the loaders query it. */
function nextPage(cursor: string | null, pageSize: number): typeof ROWS {
  const decoded = decodeCreatedIdCursor(cursor);
  const filtered = decoded
    ? ROWS.filter((r) => matchesWhere(r as Row, createdIdAfter(decoded)))
    : ROWS;
  return sortBy(filtered, CREATED_ID_DESC).slice(0, pageSize);
}

describe("paging forward across millisecond ties", () => {
  it("visits every row exactly once, for every page size", () => {
    for (const pageSize of [1, 2, 3, 4, 5]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 20; guard++) {
        const page = nextPage(cursor, pageSize);
        if (page.length === 0) break;
        seen.push(...page.map((r) => r.id));
        cursor = encodeCreatedIdCursor(page[page.length - 1]);
      }
      // No row skipped (the b2/b3/b4 tie used to vanish when a page broke
      // mid-tie) and none duplicated.
      expect([...seen].sort(), `pageSize ${pageSize}`).toEqual(
        ROWS.map((r) => r.id).sort(),
      );
      expect(new Set(seen).size, `pageSize ${pageSize}`).toBe(ROWS.length);
    }
  });

  it("a page breaking mid-tie continues INSIDE the tie, not after it", () => {
    // Page of 2 from the top lands mid-way through the t+3ms tie.
    const page1 = nextPage(null, 2); // f1, e1
    const page2 = nextPage(encodeCreatedIdCursor(page1[1]), 2); // d3, d2
    const page3 = nextPage(encodeCreatedIdCursor(page2[1]), 2); // d1, c1
    expect(page2.map((r) => r.id)).toEqual(["d3", "d2"]);
    expect(page3.map((r) => r.id)).toEqual(["d1", "c1"]);
  });

  it("the old strict-lt cursor demonstrably lost the tied rows (regression witness)", () => {
    // Desc order: f1 e1 d3 d2 d1 c1 | b4 b3 b2 b1 a1 — a page of 7 breaks
    // INSIDE the four-row t+1ms tie, right after b4.
    const page1 = sortBy(ROWS, CREATED_ID_DESC).slice(0, 7);
    expect(page1[page1.length - 1].id).toBe("b4");
    const boundary = page1[page1.length - 1].createdAt;
    const oldNext = ROWS.filter((r) => r.createdAt.getTime() < boundary.getTime());
    // b1/b2/b3 share b4's millisecond — the bare-timestamp query drops them.
    expect(oldNext.map((r) => r.id).sort()).toEqual(["a1"]);
    // The compound cursor keeps them.
    const fixedNext = nextPage(encodeCreatedIdCursor(page1[page1.length - 1]), 7);
    expect(fixedNext.map((r) => r.id)).toEqual(["b3", "b2", "b1", "a1"]);
  });
});

describe("paging backward", () => {
  it("prev from a mid-tie cursor returns exactly the rows before it, in page order", () => {
    // Forward pages of 3: [f1 e1 d3] [d2 d1 c1] …; "prev" from page 2's head.
    const pages = [nextPage(null, 3)];
    pages.push(nextPage(encodeCreatedIdCursor(pages[0][2]), 3));
    const prevCursor = decodeCreatedIdCursor(
      encodeCreatedIdCursor(pages[1][0]),
    )!;
    const before = sortBy(
      ROWS.filter((r) => matchesWhere(r as Row, createdIdBefore(prevCursor))),
      CREATED_ID_ASC,
    )
      .slice(0, 3)
      .reverse();
    expect(before.map((r) => r.id)).toEqual(pages[0].map((r) => r.id));
  });
});

describe("cursor wire format", () => {
  it("round-trips createdAt + id", () => {
    const cursor = encodeCreatedIdCursor({
      createdAt: new Date("2026-08-06T10:00:00.123Z"),
      id: "cmev_abc123",
    });
    expect(cursor).toBe("2026-08-06T10:00:00.123Z~cmev_abc123");
    const decoded = decodeCreatedIdCursor(cursor)!;
    expect(decoded.at.toISOString()).toBe("2026-08-06T10:00:00.123Z");
    expect(decoded.id).toBe("cmev_abc123");
  });

  it("accepts a legacy bare-timestamp cursor (old tab) and degrades to strict comparison", () => {
    const decoded = decodeCreatedIdCursor("2026-08-06T10:00:00.001Z")!;
    expect(decoded.id).toBeNull();
    // Degraded condition: plain lt — the ONE request from a stale link keeps
    // the old semantics; every link the response emits is compound again.
    expect(createdIdAfter(decoded)).toEqual({
      createdAt: { lt: decoded.at },
    });
  });

  it("rejects garbage", () => {
    expect(decodeCreatedIdCursor(null)).toBeNull();
    expect(decodeCreatedIdCursor("not-a-date~x")).toBeNull();
    expect(decodeCreatedIdCursor("")).toBeNull();
  });
});
