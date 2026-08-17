import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DESIGN CALENDAR (ledger.server.ts, v1.26.0)
 *
 *  1. resolveDesignFromRevisions: latest published revision at/before `at`;
 *     per-market override (config.markets[handle].preset) wins over the
 *     default preset; preselect maps subscription→sub, one_time→one,
 *     inherit→sub ONLY for subscription_ultra_max else null; null before the
 *     first publish; unsorted input tolerated.
 *  2. isTransition: a publish within 24h before `at` (inclusive of at,
 *     exclusive of the floor); custom window.
 *  3. buildDesignCalendar: one period per (market|default) per contiguous
 *     stretch, unchanged republishes merge, relabel/reset starts a new
 *     period, newest first, `since` filter, cap 200.
 *  4. loadLedgerRevisions / resolveDesignAt / getDesignCalendar read only
 *     PUBLISHED revisions, oldest first (prisma mocked).
 */

const dbMocks = vi.hoisted(() => ({
  revisionFindMany: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("~/db.server", () => ({
  default: {
    widgetDesignRevision: { findMany: dbMocks.revisionFindMany },
  },
}));

import {
  TRANSITION_WINDOW_MS,
  buildDesignCalendar,
  getDesignCalendar,
  isTransition,
  loadLedgerRevisions,
  resolveDesignAt,
  resolveDesignFromRevisions,
  type LedgerRevision,
} from "~/lib/design-measurement/ledger.server";

const T = (iso: string) => new Date(iso);

function rev(
  id: string,
  publishedAt: string,
  preset: string,
  opts: {
    preselect?: "inherit" | "subscription" | "one_time";
    markets?: Record<string, { preset: string }>;
    label?: string | null;
    configPreset?: string;
  } = {},
): LedgerRevision {
  return {
    id,
    preset,
    publishedAt: T(publishedAt),
    label: opts.label ?? null,
    config: {
      version: 1,
      preset: opts.configPreset ?? preset,
      behavior: { preselect: opts.preselect ?? "inherit", animation: true },
      markets: opts.markets ?? {},
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.revisionFindMany.mockResolvedValue([]);
});

describe("resolveDesignFromRevisions", () => {
  const revisions = [
    rev("r1", "2026-08-01T10:00:00Z", "classic"),
    rev("r2", "2026-08-10T10:00:00Z", "subscription_max", {
      preselect: "subscription",
      markets: { de: { preset: "tiles" } },
      label: "Test 1",
    }),
    rev("r3", "2026-08-20T10:00:00Z", "subscription_ultra_max", {
      preselect: "inherit",
    }),
  ];

  it("returns null before the first publish", () => {
    expect(resolveDesignFromRevisions(revisions, T("2026-07-31T23:59:59Z"), null)).toBeNull();
    expect(resolveDesignFromRevisions([], T("2026-09-01T00:00:00Z"), null)).toBeNull();
  });

  it("picks the latest revision published at or before `at` (inclusive)", () => {
    expect(resolveDesignFromRevisions(revisions, T("2026-08-01T10:00:00Z"), null)).toMatchObject({
      designKey: "classic",
      revisionId: "r1",
      preselect: null,
      label: null,
    });
    expect(resolveDesignFromRevisions(revisions, T("2026-08-15T00:00:00Z"), null)).toMatchObject({
      designKey: "subscription_max",
      revisionId: "r2",
      preselect: "sub",
      label: "Test 1",
    });
    expect(resolveDesignFromRevisions(revisions, T("2026-09-01T00:00:00Z"), null)).toMatchObject({
      designKey: "subscription_ultra_max",
      revisionId: "r3",
    });
  });

  it("applies the per-market override and inherits the default elsewhere", () => {
    const at = T("2026-08-15T00:00:00Z");
    expect(resolveDesignFromRevisions(revisions, at, "de")).toMatchObject({
      designKey: "tiles",
      revisionId: "r2",
      // preselect is a base-config behavior: the market override only picks
      // the preset, so an explicit "subscription" still applies.
      preselect: "sub",
    });
    expect(resolveDesignFromRevisions(revisions, at, "ch")).toMatchObject({
      designKey: "subscription_max",
    });
    // Once r3 is live the de override is gone (r3 has no markets entry).
    expect(resolveDesignFromRevisions(revisions, T("2026-08-21T00:00:00Z"), "de")).toMatchObject({
      designKey: "subscription_ultra_max",
    });
  });

  it("maps preselect: subscription→sub, one_time→one, inherit→sub only for ultra max", () => {
    const at = T("2030-01-01T00:00:00Z");
    expect(
      resolveDesignFromRevisions([rev("a", "2026-01-01T00:00:00Z", "classic", { preselect: "subscription" })], at, null)
        ?.preselect,
    ).toBe("sub");
    expect(
      resolveDesignFromRevisions([rev("a", "2026-01-01T00:00:00Z", "classic", { preselect: "one_time" })], at, null)
        ?.preselect,
    ).toBe("one");
    expect(
      resolveDesignFromRevisions([rev("a", "2026-01-01T00:00:00Z", "classic", { preselect: "inherit" })], at, null)
        ?.preselect,
    ).toBeNull();
    expect(
      resolveDesignFromRevisions(
        [rev("a", "2026-01-01T00:00:00Z", "subscription_ultra_max", { preselect: "inherit" })],
        at,
        null,
      )?.preselect,
    ).toBe("sub");
    // Explicit one_time on ultra max stays one (the merchant said so).
    expect(
      resolveDesignFromRevisions(
        [rev("a", "2026-01-01T00:00:00Z", "subscription_ultra_max", { preselect: "one_time" })],
        at,
        null,
      )?.preselect,
    ).toBe("one");
    // A market override onto ultra max with inherit → sub for that market only.
    const r = rev("a", "2026-01-01T00:00:00Z", "classic", {
      preselect: "inherit",
      markets: { ch: { preset: "subscription_ultra_max" } },
    });
    expect(resolveDesignFromRevisions([r], at, "ch")?.preselect).toBe("sub");
    expect(resolveDesignFromRevisions([r], at, null)?.preselect).toBeNull();
  });

  it("tolerates unsorted input, a config without preset (falls back to the row's preset) and a junk config", () => {
    const shuffled = [revisions[2], revisions[0], revisions[1]];
    expect(resolveDesignFromRevisions(shuffled, T("2026-08-15T00:00:00Z"), null)?.revisionId).toBe("r2");
    const noConfig: LedgerRevision = {
      id: "x",
      preset: "planner",
      publishedAt: T("2026-01-01T00:00:00Z"),
      label: null,
      config: "not an object",
    };
    expect(resolveDesignFromRevisions([noConfig], T("2026-02-01T00:00:00Z"), "de")).toEqual({
      designKey: "planner",
      preselect: null,
      revisionId: "x",
      label: null,
    });
    // Invalid `at` never throws.
    expect(resolveDesignFromRevisions(revisions, new Date("nope"), null)).toBeNull();
  });
});

describe("isTransition", () => {
  const revisions = [rev("r1", "2026-08-10T10:00:00Z", "classic")];

  it("flags instants within 24h AFTER a publish, inclusive of the publish instant", () => {
    expect(TRANSITION_WINDOW_MS).toBe(24 * 3_600_000);
    expect(isTransition(revisions, T("2026-08-10T10:00:00Z"))).toBe(true);
    expect(isTransition(revisions, T("2026-08-11T09:59:59Z"))).toBe(true);
    // Exactly 24h later: the floor is exclusive, so no longer a transition.
    expect(isTransition(revisions, T("2026-08-11T10:00:00Z"))).toBe(false);
    // Before the publish: not a transition (the previous design was live).
    expect(isTransition(revisions, T("2026-08-10T09:59:59Z"))).toBe(false);
  });

  it("honours a custom window and never throws on junk", () => {
    expect(isTransition(revisions, T("2026-08-10T11:00:00Z"), 30 * 60_000)).toBe(false);
    expect(isTransition(revisions, T("2026-08-10T10:20:00Z"), 30 * 60_000)).toBe(true);
    expect(isTransition(revisions, T("2026-08-10T10:20:00Z"), 0)).toBe(false);
    expect(isTransition(revisions, new Date("nope"))).toBe(false);
    expect(isTransition([], T("2026-08-10T10:20:00Z"))).toBe(false);
  });
});

describe("buildDesignCalendar", () => {
  it("emits one period per (market|default) per contiguous stretch, newest first", () => {
    const revisions = [
      rev("r1", "2026-08-01T10:00:00Z", "classic"),
      rev("r2", "2026-08-10T10:00:00Z", "subscription_max", {
        preselect: "subscription",
        markets: { de: { preset: "tiles" } },
        label: "Test 1",
      }),
      rev("r3", "2026-08-20T10:00:00Z", "subscription_ultra_max"),
    ];
    const calendar = buildDesignCalendar(revisions);
    // default: classic → subscription_max(sub, Test 1) → ultra max
    // de:      classic → tiles(sub, Test 1)            → ultra max
    expect(calendar).toHaveLength(6);
    expect(calendar.map((p) => [p.marketHandle, p.preset, p.revisionId, p.from.toISOString(), p.to?.toISOString() ?? null])).toEqual([
      [null, "subscription_ultra_max", "r3", "2026-08-20T10:00:00.000Z", null],
      ["de", "subscription_ultra_max", "r3", "2026-08-20T10:00:00.000Z", null],
      [null, "subscription_max", "r2", "2026-08-10T10:00:00.000Z", "2026-08-20T10:00:00.000Z"],
      ["de", "tiles", "r2", "2026-08-10T10:00:00.000Z", "2026-08-20T10:00:00.000Z"],
      [null, "classic", "r1", "2026-08-01T10:00:00.000Z", "2026-08-10T10:00:00.000Z"],
      ["de", "classic", "r1", "2026-08-01T10:00:00.000Z", "2026-08-10T10:00:00.000Z"],
    ]);
    const test1 = calendar.find((p) => p.revisionId === "r2" && p.marketHandle == null);
    expect(test1).toMatchObject({ label: "Test 1", preselect: "sub" });
    // The ultra max period resolves inherit → sub.
    expect(calendar[0].preselect).toBe("sub");
  });

  it("merges unchanged republishes (colour tweaks) but splits on a relabel", () => {
    const revisions = [
      rev("r1", "2026-08-01T10:00:00Z", "classic"),
      rev("r2", "2026-08-02T10:00:00Z", "classic"), // same design, no label
      rev("r3", "2026-08-03T10:00:00Z", "classic", { label: "Control" }), // relabel = new period
      rev("r4", "2026-08-04T10:00:00Z", "classic", { label: "Control" }), // merged into r3's
    ];
    const calendar = buildDesignCalendar(revisions);
    expect(calendar.map((p) => [p.revisionId, p.label, p.from.toISOString(), p.to?.toISOString() ?? null])).toEqual([
      ["r3", "Control", "2026-08-03T10:00:00.000Z", null],
      ["r1", null, "2026-08-01T10:00:00.000Z", "2026-08-03T10:00:00.000Z"],
    ]);
  });

  it("filters with `since` (periods still live at/after it) and caps at 200", () => {
    const revisions = [
      rev("r1", "2026-08-01T10:00:00Z", "classic"),
      rev("r2", "2026-08-10T10:00:00Z", "tiles"),
      rev("r3", "2026-08-20T10:00:00Z", "planner"),
    ];
    const since = buildDesignCalendar(revisions, { since: T("2026-08-15T00:00:00Z") });
    expect(since.map((p) => p.revisionId)).toEqual(["r3", "r2"]);

    const many: LedgerRevision[] = [];
    for (let i = 0; i < 260; i++) {
      many.push(
        rev(`m${i}`, new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString(), i % 2 ? "classic" : "tiles"),
      );
    }
    expect(buildDesignCalendar(many)).toHaveLength(200);
    expect(buildDesignCalendar([])).toEqual([]);
  });
});

describe("DB-backed readers", () => {
  it("loadLedgerRevisions reads only PUBLISHED revisions, oldest first, and drops rows without publishedAt", async () => {
    dbMocks.revisionFindMany.mockResolvedValue([
      { id: "a", preset: "classic", config: {}, publishedAt: T("2026-08-01T00:00:00Z"), label: null },
      { id: "b", preset: "tiles", config: {}, publishedAt: null, label: "draft" },
      { id: "c", preset: "planner", config: {}, publishedAt: T("2026-08-05T00:00:00Z"), label: "P" },
    ]);
    const revisions = await loadLedgerRevisions("shop_1");
    expect(dbMocks.revisionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId: "shop_1", publishedAt: { not: null } },
        orderBy: { publishedAt: "asc" },
      }),
    );
    expect(revisions.map((r) => r.id)).toEqual(["a", "c"]);
    expect(revisions[1].label).toBe("P");
  });

  it("resolveDesignAt and getDesignCalendar compose the loader with the pure functions", async () => {
    dbMocks.revisionFindMany.mockResolvedValue([
      {
        id: "a",
        preset: "classic",
        config: { preset: "classic", behavior: { preselect: "one_time" }, markets: { ch: { preset: "tiles" } } },
        publishedAt: T("2026-08-01T00:00:00Z"),
        label: "Launch",
      },
    ]);
    expect(await resolveDesignAt("shop_1", T("2026-08-02T00:00:00Z"), "ch")).toEqual({
      designKey: "tiles",
      preselect: "one",
      revisionId: "a",
      label: "Launch",
    });
    expect(await resolveDesignAt("shop_1", T("2026-07-02T00:00:00Z"), "ch")).toBeNull();
    const calendar = await getDesignCalendar("shop_1");
    expect(calendar.map((p) => [p.marketHandle, p.preset])).toEqual([
      [null, "classic"],
      ["ch", "tiles"],
    ]);
  });
});
