import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Self-improving churn-risk core (v1.5.0, app/lib/analytics/learning.server.ts
 * + risk.server.ts).
 *
 * What is pinned here, and why it is load-bearing:
 *  - the logistic trainer CONVERGES on a separable synthetic set and is
 *    byte-deterministic (no RNG anywhere — same data, same weights);
 *  - it REFUSES degenerate inputs (empty / ragged / single-class) and the
 *    nightly run refuses to train below the outcome thresholds — the merchant
 *    must never be scored by a model fit on nothing;
 *  - standardization round-trips (scale-invariance): a feature measured in
 *    cents trains the same scorer as one measured in francs;
 *  - rank AUC on hand-computed rankings, ties included — the number the
 *    promotion decision hangs on must be exactly right;
 *  - the PROMOTION GATE: a learned model that does not beat the heuristic's
 *    holdout AUC by PROMOTION_AUC_MARGIN stays in shadow, and risk.server
 *    keeps scoring with the heuristic (also when the stored model's feature
 *    space no longer matches);
 *  - the LABEL-LEAKAGE guard in buildRiskSnapshots: features at time T are
 *    reconstructable from data ≤ T only, the label window is strictly
 *    (T, T+OUTCOME_WINDOW_DAYS], and undecided outcomes are excluded — a
 *    model that peeks at its own future would post a fantasy AUC and steal
 *    the scorer from the honest heuristic.
 *
 * DB access is mocked with per-test vi.fn tables (forecast.test.ts pattern);
 * the Setting store is a real in-memory map served through the REAL
 * settings.server + zod registry, so the riskModel value the trainer writes
 * must genuinely round-trip the schema the scorer reads.
 */

const mocks = vi.hoisted(() => {
  const settingStore = new Map<string, { shopId: string; key: string; value: unknown }>();
  const keyOf = (where: Record<string, any>): string => {
    const compound = where.shopId_key as { shopId: string; key: string };
    return `${compound.shopId}:${compound.key}`;
  };
  return {
    settingStore,
    logEvent: vi.fn(async (_e: Record<string, unknown>): Promise<void> => {}),
    contractFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
    contractUpdateMany: vi.fn(
      async (args: { where?: { id?: { in?: string[] } } }) => ({
        count: args?.where?.id?.in?.length ?? 0,
      }),
    ),
    eventFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
    dunningCaseFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
    jobRunFindFirst: vi.fn(async (): Promise<unknown> => null),
    settingFindUnique: vi.fn(async (args: { where: Record<string, unknown> }) => {
      return settingStore.get(keyOf(args.where)) ?? null;
    }),
    settingUpsert: vi.fn(
      async (args: {
        where: Record<string, unknown>;
        create: { shopId: string; key: string; value: unknown };
        update: { value: unknown };
      }) => {
        const key = keyOf(args.where);
        const existing = settingStore.get(key);
        if (existing) {
          existing.value = args.update.value;
          return existing;
        }
        const created = {
          shopId: args.create.shopId,
          key: args.create.key,
          value: args.create.value,
        };
        settingStore.set(key, created);
        return created;
      },
    ),
  };
});

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findMany: mocks.contractFindMany,
      updateMany: mocks.contractUpdateMany,
    },
    subscriberEvent: { findMany: mocks.eventFindMany },
    dunningCase: { findMany: mocks.dunningCaseFindMany },
    setting: { findUnique: mocks.settingFindUnique, upsert: mocks.settingUpsert },
    jobRun: { findFirst: mocks.jobRunFindFirst },
  },
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

import {
  MIN_NEGATIVE_OUTCOMES,
  MIN_POSITIVE_OUTCOMES,
  OUTCOME_WINDOW_DAYS,
  PROMOTION_AUC_MARGIN,
  RISK_FEATURE_NAMES,
  SNAPSHOT_EPOCH_MS,
  SNAPSHOT_INTERVAL_DAYS,
  SNAPSHOT_LOOKBACK_DAYS,
  buildRiskSnapshots,
  extractFeatures,
  heuristicRiskScore,
  precisionAtTopDecile,
  predictProbability,
  rankAuc,
  runRiskLearning,
  splitByTime,
  trainLogisticRegression,
  type RiskFeatureInput,
  type SnapshotContractRow,
  type SnapshotEventRow,
} from "~/lib/analytics/learning.server";
import { getRiskModelStatus, runChurnRiskScoring } from "~/lib/analytics/risk.server";
import { getSetting } from "~/lib/settings/settings.server";

const DAY = 86_400_000;
const SHOP = "shop_1";
const NOW = new Date("2026-08-01T00:00:00.000Z");

/** The snapshot grid exactly as buildRiskSnapshots computes it for NOW. */
function snapshotGrid(now: Date): number[] {
  const nowMs = now.getTime();
  const windowStart = nowMs - SNAPSHOT_LOOKBACK_DAYS * DAY;
  const firstIdx = Math.ceil(
    (windowStart - SNAPSHOT_EPOCH_MS) / (SNAPSHOT_INTERVAL_DAYS * DAY),
  );
  const grid: number[] = [];
  for (let k = Math.max(0, firstIdx); ; k++) {
    const t = SNAPSHOT_EPOCH_MS + k * SNAPSHOT_INTERVAL_DAYS * DAY;
    if (t + OUTCOME_WINDOW_DAYS * DAY > nowMs) break;
    grid.push(t);
  }
  return grid;
}
const GRID = snapshotGrid(NOW);

function contractRow(id: string, over: Partial<SnapshotContractRow>): SnapshotContractRow {
  return {
    id,
    intervalWeeks: 4,
    ordersCount: 5,
    skipCount: 0,
    createdAt: new Date(GRID[0] - 100 * DAY),
    firstChargeAt: new Date(GRID[0] - 100 * DAY),
    cancelledAt: null,
    cancelReason: null,
    failedAt: null,
    customerId: null,
    email: null,
    originOrderTotalCents: 8000,
    originOrderDiscountCents: 0,
    ...over,
  };
}

/**
 * 60 negatives (never churn, snapshots at every grid time) + 60 positives
 * staggered across the grid (arrive 40d before "their" grid time, cancel 20d
 * after it — every snapshot they produce is labelled 1). `signal` decides what
 * separates the classes:
 *  - "acq":     positives have a tiny origin order (500c vs 20000c) — a signal
 *               the heuristic is BLIND to (its scores stay flat), so the
 *               learned model must win the holdout and get promoted;
 *  - "dunning": positives have an open dunning case — the heuristic's own
 *               strongest factor, so the learned model can at best TIE and
 *               must stay in shadow.
 */
function buildBook(signal: "acq" | "dunning"): {
  contracts: SnapshotContractRow[];
  events: SnapshotEventRow[];
} {
  const contracts: SnapshotContractRow[] = [];
  const events: SnapshotEventRow[] = [];
  for (let i = 0; i < 60; i++) {
    contracts.push(
      contractRow(`neg_${String(i).padStart(2, "0")}`, {
        originOrderTotalCents: signal === "acq" ? 20_000 : 8000,
      }),
    );
  }
  for (let i = 0; i < 60; i++) {
    const gi = i % GRID.length;
    const arrival = new Date(GRID[gi] - 40 * DAY);
    contracts.push(
      contractRow(`pos_${String(i).padStart(2, "0")}`, {
        createdAt: arrival,
        firstChargeAt: arrival,
        cancelledAt: new Date(GRID[gi] + 20 * DAY),
        cancelReason: "TOO_EXPENSIVE",
        originOrderTotalCents: signal === "acq" ? 500 : 8000,
      }),
    );
    if (signal === "dunning") {
      events.push({
        contractId: `pos_${String(i).padStart(2, "0")}`,
        customerId: null,
        email: null,
        type: "dunning.case_opened",
        createdAt: arrival,
      });
    }
  }
  return { contracts, events };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settingStore.clear();
  mocks.contractFindMany.mockResolvedValue([]);
  mocks.eventFindMany.mockResolvedValue([]);
  mocks.dunningCaseFindMany.mockResolvedValue([]);
  mocks.jobRunFindFirst.mockResolvedValue(null);
});

// ── Sanity on the synthetic grid ─────────────────────────────────────────────

describe("snapshot grid fixture", () => {
  it("spans enough grid times for a meaningful time split", () => {
    expect(GRID.length).toBeGreaterThanOrEqual(10);
    // Every snapshot time leaves the outcome window fully decided.
    for (const t of GRID) {
      expect(t + OUTCOME_WINDOW_DAYS * DAY).toBeLessThanOrEqual(NOW.getTime());
    }
  });
});

// ── trainLogisticRegression: convergence, determinism, refusals ──────────────

describe("trainLogisticRegression", () => {
  const rows = [[0], [0.1], [0.2], [5], [5.1], [5.2]];
  const labels = [0, 0, 0, 1, 1, 1];

  it("converges on a separable set: high side ≫ low side, AUC 1", () => {
    const model = trainLogisticRegression(rows, labels, { featureNames: ["x"] });
    expect(model).not.toBeNull();
    const scores = rows.map((r) => predictProbability(model!, r));
    expect(scores[5]).toBeGreaterThan(0.8);
    expect(scores[0]).toBeLessThan(0.2);
    expect(rankAuc(scores, labels)).toBe(1);
  });

  it("is deterministic — two runs on the same data yield identical weights", () => {
    const a = trainLogisticRegression(rows, labels);
    const b = trainLogisticRegression(rows, labels);
    expect(a).toEqual(b);
  });

  it("returns null on empty rows", () => {
    expect(trainLogisticRegression([], [])).toBeNull();
  });

  it("returns null on ragged rows (width disagreement)", () => {
    expect(trainLogisticRegression([[1, 2], [1]], [0, 1])).toBeNull();
  });

  it("returns null on label/row length mismatch", () => {
    expect(trainLogisticRegression([[1], [2]], [0])).toBeNull();
  });

  it("returns null on single-class labels — nothing to separate", () => {
    expect(trainLogisticRegression([[1], [2]], [1, 1])).toBeNull();
    expect(trainLogisticRegression([[1], [2]], [0, 0])).toBeNull();
  });

  it("defaults featureNames to the fixed RISK_FEATURE_NAMES vocabulary", () => {
    const model = trainLogisticRegression(rows, labels);
    expect(model!.featureNames).toEqual([...RISK_FEATURE_NAMES]);
  });
});

// ── Standardization round-trip ───────────────────────────────────────────────

describe("standardization round-trip", () => {
  it("stores the training-set means/stds and applies them at predict time", () => {
    const rows = [
      [10, 1000],
      [20, 3000],
      [30, 2000],
      [40, 4000],
    ];
    const labels = [0, 0, 1, 1];
    const model = trainLogisticRegression(rows, labels)!;

    expect(model.means[0]).toBeCloseTo(25, 10);
    expect(model.means[1]).toBeCloseTo(2500, 10);
    // Population stdev: sqrt(mean of squared deviations).
    expect(model.stds[0]).toBeCloseTo(Math.sqrt(125), 10);
    expect(model.stds[1]).toBeCloseTo(Math.sqrt(1_250_000), 10);

    // predictProbability must be exactly sigmoid(intercept + Σ w·(x−μ)/σ).
    const x = [17, 2600];
    let z = model.intercept;
    for (let j = 0; j < 2; j++) {
      z += model.weights[j] * ((x[j] - model.means[j]) / model.stds[j]);
    }
    expect(predictProbability(model, x)).toBeCloseTo(1 / (1 + Math.exp(-z)), 12);
  });

  it("is scale-invariant: cents vs francs trains the identical scorer", () => {
    const centsRows = [[100], [200], [50_000], [60_000]];
    const francRows = centsRows.map((r) => [r[0] / 100]);
    const labels = [1, 1, 0, 0];
    const cents = trainLogisticRegression(centsRows, labels)!;
    const francs = trainLogisticRegression(francRows, labels)!;
    // Standardized inputs are identical, so the learned weights are too…
    expect(cents.weights[0]).toBeCloseTo(francs.weights[0], 12);
    // …and every prediction matches across the unit change.
    for (let i = 0; i < centsRows.length; i++) {
      expect(predictProbability(cents, centsRows[i])).toBeCloseTo(
        predictProbability(francs, francRows[i]),
        12,
      );
    }
  });

  it("floors a constant feature's std — no NaN, no exploding weight", () => {
    const model = trainLogisticRegression(
      [
        [1, 7],
        [2, 7],
        [3, 7],
        [4, 7],
      ],
      [0, 0, 1, 1],
    )!;
    expect(model.stds[1]).toBe(1); // flooring, not 0
    for (const w of model.weights) expect(Number.isFinite(w)).toBe(true);
    expect(Number.isFinite(predictProbability(model, [2.5, 7]))).toBe(true);
  });
});

// ── rankAuc / precisionAtTopDecile ───────────────────────────────────────────

describe("rankAuc", () => {
  it("perfect ranking scores 1, inverted ranking 0", () => {
    expect(rankAuc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1])).toBe(1);
    expect(rankAuc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1])).toBe(0);
  });

  it("all-tied scores are chance (0.5) via average ranks", () => {
    expect(rankAuc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1])).toBe(0.5);
  });

  it("hand-computed partial tie: [0.9, 0.5, 0.5, 0.1] / [1,1,0,0] → 0.875", () => {
    // Ranks: 0.1→1, the tied 0.5s→2.5 each, 0.9→4.
    // posRankSum = 4 + 2.5 = 6.5; AUC = (6.5 − 2·3/2) / (2·2) = 0.875.
    expect(rankAuc([0.9, 0.5, 0.5, 0.1], [1, 1, 0, 0])).toBe(0.875);
  });

  it("returns null when a class is absent or inputs are empty/mismatched", () => {
    expect(rankAuc([], [])).toBeNull();
    expect(rankAuc([0.5, 0.6], [1, 1])).toBeNull();
    expect(rankAuc([0.5, 0.6], [0, 0])).toBeNull();
    expect(rankAuc([0.5], [1, 0])).toBeNull();
  });
});

describe("precisionAtTopDecile", () => {
  it("scores the top-decile hit rate with deterministic tie-breaks", () => {
    // n=20 → take 2. Top scores 0.99 (churner) and 0.98 (not) → 1/2.
    const scores = [0.99, 0.98, ...Array.from({ length: 18 }, (_, i) => 0.5 - i * 0.01)];
    const labels = [1, 0, ...Array.from({ length: 18 }, (_, i) => (i % 2) as 0 | 1)];
    expect(precisionAtTopDecile(scores, labels)).toBe(0.5);
  });

  it("takes at least one row on tiny sets and returns null on empty", () => {
    expect(precisionAtTopDecile([0.9, 0.1], [1, 0])).toBe(1);
    expect(precisionAtTopDecile([], [])).toBeNull();
  });
});

// ── splitByTime ──────────────────────────────────────────────────────────────

describe("splitByTime", () => {
  /** Row at grid time t with a payload id so we can assert exact membership. */
  const row = (id: string, t: number) => ({ id, snapshotAt: new Date(t) });
  const T0 = SNAPSHOT_EPOCH_MS;
  const STEP = SNAPSHOT_INTERVAL_DAYS * DAY;

  it("holds out the NEWEST snapshot times (time split, not random)", () => {
    // 10 rows across 10 distinct grid times, far enough apart that no purge applies.
    const rows = Array.from({ length: 10 }, (_, i) =>
      row(`r${i}`, T0 + i * 3 * STEP),
    );
    const { train, holdout } = splitByTime(rows);
    expect(holdout.map((r) => r.id)).toEqual(["r8", "r9"]);
    expect(train.map((r) => r.id)).toEqual([
      "r0",
      "r1",
      "r2",
      "r3",
      "r4",
      "r5",
      "r6",
      "r7",
    ]);
  });

  it("handles empty input and custom fractions", () => {
    expect(splitByTime([])).toEqual({ train: [], holdout: [] });
    const four = [0, 1, 2, 3].map((i) => row(`r${i}`, T0 + i * 3 * STEP));
    const { train, holdout } = splitByTime(four, 0.5);
    expect(train.map((r) => r.id)).toEqual(["r0", "r1"]);
    expect(holdout.map((r) => r.id)).toEqual(["r2", "r3"]);
  });

  it("never splits rows sharing a snapshot time across the boundary", () => {
    // 10 rows, but the naive 20% row-count boundary falls INSIDE the group at
    // time T0+9*3*STEP (three siblings). All three must land in the holdout —
    // a shop-wide shock at one grid time may not straddle the split.
    const shockT = T0 + 9 * 3 * STEP;
    const rows = [
      ...Array.from({ length: 7 }, (_, i) => row(`old${i}`, T0 + i * 3 * STEP)),
      row("shockA", shockT),
      row("shockB", shockT),
      row("shockC", shockT),
    ];
    const { train, holdout } = splitByTime(rows);
    expect(holdout.map((r) => r.id)).toEqual(["shockA", "shockB", "shockC"]);
    expect(train.every((r) => r.snapshotAt.getTime() < shockT)).toBe(true);
  });

  it("purges train rows whose outcome window overlaps the holdout's label period", () => {
    // Grid-adjacent rows: with a 28-day grid and a 60-day outcome window, the
    // two train rows immediately before the boundary (boundary−28d and
    // boundary−56d) have label windows reaching past the boundary — their
    // labels are decided by the same period the holdout is scored on. They
    // must be purged; boundary−84d and older stay.
    const rows = Array.from({ length: 10 }, (_, i) => row(`g${i}`, T0 + i * STEP));
    const boundary = T0 + 8 * STEP;
    const { train, holdout } = splitByTime(rows);
    expect(holdout.map((r) => r.id)).toEqual(["g8", "g9"]);
    // g7 (boundary−28d) and g6 (boundary−56d): window end > boundary → purged.
    expect(train.map((r) => r.id)).toEqual(["g0", "g1", "g2", "g3", "g4", "g5"]);
    for (const r of train) {
      expect(
        r.snapshotAt.getTime() + OUTCOME_WINDOW_DAYS * DAY,
      ).toBeLessThanOrEqual(boundary);
    }
  });

  it("degrades honestly when every row shares one snapshot time (all rows go to holdout)", () => {
    const rows = [row("a", T0), row("b", T0), row("c", T0)];
    const { train, holdout } = splitByTime(rows);
    expect(train).toEqual([]);
    expect(holdout.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

// ── buildRiskSnapshots: the label-leakage guard ──────────────────────────────

describe("buildRiskSnapshots — no label leakage", () => {
  const T = GRID[5];
  const arrival = new Date(T - 100 * DAY);

  function snapshotsFor(
    over: Partial<SnapshotContractRow>,
    events: SnapshotEventRow[] = [],
  ) {
    return buildRiskSnapshots({
      contracts: [contractRow("c1", { createdAt: arrival, firstChargeAt: arrival, ...over })],
      events,
      now: NOW,
    });
  }

  function at(snaps: ReturnType<typeof buildRiskSnapshots>, t: number) {
    return snaps.find((s) => s.snapshotAt.getTime() === t);
  }

  it("events AFTER the snapshot time never signal — they only subtract counters", () => {
    const events: SnapshotEventRow[] = [
      // Post-T activity: two more successful cycles and an opened dunning case.
      { contractId: "c1", customerId: null, email: null, type: "billing.attempt_succeeded", createdAt: new Date(T + 5 * DAY) },
      { contractId: "c1", customerId: null, email: null, type: "billing.attempt_succeeded", createdAt: new Date(T + 10 * DAY) },
      { contractId: "c1", customerId: null, email: null, type: "dunning.case_opened", createdAt: new Date(T + 1 * DAY) },
    ];
    const snap = at(snapshotsFor({ ordersCount: 5 }, events), T)!;
    // ordersCount at T = today's 5 minus the 2 post-T successes.
    expect(snap.input.ordersCount).toBe(3);
    // The post-T dunning case is invisible at T.
    expect(snap.input.openDunning).toBe(false);

    // At the NEXT grid time both successes are ≤ T' → full count, and the
    // case (opened before T', never resolved) is now visible. Same events,
    // different cutoff — the cutoff is the guard.
    const next = at(snapshotsFor({ ordersCount: 5 }, events), GRID[6])!;
    expect(next.input.ordersCount).toBe(5);
    expect(next.input.openDunning).toBe(true);
  });

  it("a dunning case opened BEFORE T does signal at T", () => {
    const snap = at(
      snapshotsFor({}, [
        { contractId: "c1", customerId: null, email: null, type: "dunning.case_opened", createdAt: new Date(T - 3 * DAY) },
      ]),
      T,
    )!;
    expect(snap.input.openDunning).toBe(true);
  });

  it("undecided outcomes are excluded entirely — no snapshot inside the last outcome window", () => {
    const snaps = snapshotsFor({});
    for (const s of snaps) {
      expect(s.snapshotAt.getTime() + OUTCOME_WINDOW_DAYS * DAY).toBeLessThanOrEqual(
        NOW.getTime(),
      );
    }
  });

  it("label window is strictly (T, T+window]: cancel AT T yields no snapshot at T", () => {
    const snaps = snapshotsFor({
      cancelledAt: new Date(T),
      cancelReason: "TOO_EXPENSIVE",
    });
    expect(at(snaps, T)).toBeUndefined(); // already churned at T
    // The preceding grid time sees the cancel inside ITS window → label 1.
    expect(at(snaps, GRID[4])!.label).toBe(1);
  });

  it("cancel exactly at T+window is inside (inclusive end)", () => {
    const snaps = snapshotsFor({
      cancelledAt: new Date(T + OUTCOME_WINDOW_DAYS * DAY),
      cancelReason: "TOO_EXPENSIVE",
    });
    expect(at(snaps, T)!.label).toBe(1);
  });

  it("cancel just past T+window is outside — label 0 at T, 1 at the next grid time", () => {
    const snaps = snapshotsFor({
      cancelledAt: new Date(T + OUTCOME_WINDOW_DAYS * DAY + 1),
      cancelReason: "TOO_EXPENSIVE",
    });
    expect(at(snaps, T)!.label).toBe(0);
    expect(at(snaps, GRID[6])!.label).toBe(1);
  });

  it("consolidation merges (cancelReason MERGED) are never labelled churn", () => {
    const snaps = snapshotsFor({
      cancelledAt: new Date(T + 20 * DAY),
      cancelReason: "MERGED",
    });
    expect(at(snaps, T)!.label).toBe(0);
  });

  it("entering FAILED (involuntary churn) labels exactly like a cancel", () => {
    const snaps = snapshotsFor({ failedAt: new Date(T + 20 * DAY) });
    expect(at(snaps, T)!.label).toBe(1);
    // …and once failed, later grid times produce no snapshot at all.
    expect(at(snaps, GRID[6])).toBeUndefined();
  });

  it("a contract paused at T produces no snapshot; resuming brings it back", () => {
    const events: SnapshotEventRow[] = [
      { contractId: "c1", customerId: null, email: null, type: "contract.paused", createdAt: new Date(T - 5 * DAY) },
      { contractId: "c1", customerId: null, email: null, type: "contract.resumed", createdAt: new Date(T + 5 * DAY) },
    ];
    const snaps = snapshotsFor({}, events);
    expect(at(snaps, T)).toBeUndefined();
    expect(at(snaps, GRID[6])).toBeDefined();
  });

  it("portal logins are only seen within the lookback and never from the future", () => {
    const snaps = snapshotsFor({ customerId: "gid://shopify/Customer/9" }, [
      { contractId: null, customerId: "gid://shopify/Customer/9", email: null, type: "portal.login", createdAt: new Date(T + 2 * DAY) },
    ]);
    // The login happens AFTER T — daysSinceLogin at T must not see it.
    expect(at(snaps, T)!.input.daysSinceLogin).toBeNull();
    // At the next grid time it is 26 days in the past.
    expect(at(snaps, GRID[6])!.input.daysSinceLogin).toBeCloseTo(26, 6);
  });
});

// ── buildRiskSnapshots: the import boundary ──────────────────────────────────

describe("buildRiskSnapshots — import boundary (pre-install history is never fabricated)", () => {
  // Imported book (import passthrough): sync backfills firstChargeAt to the
  // ORIGIN order's historical createdAt, but the mirror row — and with it the
  // SubscriberEvent log and every walked-back counter — is only born at
  // import. Snapshot grid times before that birth would read "zero orders,
  // never logged in, no dunning, old account" for EVERY imported contract:
  // fabricated, identical rows that would dominate training for up to ~18
  // months and sandbag the heuristic's comparison AUC.
  const IMPORT_AT = GRID[8];
  const TRUE_ARRIVAL = new Date(GRID[0] - 400 * DAY);

  function importedSnaps(over: Partial<SnapshotContractRow> = {}) {
    return buildRiskSnapshots({
      contracts: [
        contractRow("imp1", {
          createdAt: new Date(IMPORT_AT),
          firstChargeAt: TRUE_ARRIVAL,
          ...over,
        }),
      ],
      events: [],
      now: NOW,
    });
  }

  it("produces no snapshot before the mirror was born, despite the historical arrival", () => {
    const snaps = importedSnaps();
    expect(snaps.length).toBeGreaterThan(0);
    for (const s of snaps) {
      expect(s.snapshotAt.getTime()).toBeGreaterThanOrEqual(IMPORT_AT);
    }
    // The grid time just before import — squarely inside the span the old
    // fabrication covered — yields nothing.
    expect(snaps.find((s) => s.snapshotAt.getTime() === GRID[7])).toBeUndefined();
  });

  it("account age at the first observed snapshot still reflects the TRUE arrival", () => {
    // The age is real even where history is not reconstructable — only the
    // grid is clamped, not the arrival semantics.
    const first = importedSnaps().find(
      (s) => s.snapshotAt.getTime() === IMPORT_AT,
    )!;
    expect(first).toBeDefined();
    expect(first.input.accountAgeDays).toBeCloseTo(
      8 * SNAPSHOT_INTERVAL_DAYS + 400,
      6,
    );
  });

  it("contracts mirrored as cancelled at import (cancelledAt = sync time) produce ZERO rows — no mass churn labels", () => {
    // sync.server.ts stamps cancelledAt = now just before the row insert, so
    // cancelledAt ≤ createdAt: with the grid clamped to createdAt, no grid
    // time can fall inside (arrival, cancelledAt) any more.
    const snaps = importedSnaps({
      cancelledAt: new Date(IMPORT_AT),
      cancelReason: null,
    });
    expect(snaps).toHaveLength(0);
  });

  it("app-era contracts are untouched: createdAt ≈ arrival keeps every grid time", () => {
    const arrival = new Date(GRID[0] - 100 * DAY);
    const snaps = buildRiskSnapshots({
      contracts: [
        contractRow("app1", { createdAt: arrival, firstChargeAt: arrival }),
      ],
      events: [],
      now: NOW,
    });
    expect(snaps.map((s) => s.snapshotAt.getTime())).toEqual(GRID);
  });
});

// ── runRiskLearning: thresholds, promotion gate, determinism ─────────────────

describe("runRiskLearning", () => {
  it("refuses to train below the outcome thresholds and says so", async () => {
    // 10 churned + 10 retained contracts — far under 50/50.
    const contracts = [
      ...Array.from({ length: 10 }, (_, i) => contractRow(`n${i}`, {})),
      ...Array.from({ length: 10 }, (_, i) =>
        contractRow(`p${i}`, {
          createdAt: new Date(GRID[2] - 40 * DAY),
          firstChargeAt: new Date(GRID[2] - 40 * DAY),
          cancelledAt: new Date(GRID[2] + 20 * DAY),
          cancelReason: "TOO_EXPENSIVE",
        }),
      ),
    ];
    mocks.contractFindMany.mockResolvedValue(contracts);

    const result = await runRiskLearning(SHOP, NOW);
    expect(result.trained).toBe(false);
    expect(result.promoted).toBe(false);
    expect(result.positives).toBe(10);
    expect(result.negatives).toBe(10);
    expect(result.reason).toContain("insufficient_outcomes");
    expect(result.reason).toContain(`${MIN_POSITIVE_OUTCOMES}+`);
    expect(result.reason).toContain(`${MIN_NEGATIVE_OUTCOMES}−`);

    // The decision is persisted honestly: heuristic mode with the counts.
    const stored = await getSetting(SHOP, "riskModel");
    expect(stored.mode).toBe("heuristic");
    expect(stored.promoted).toBe(false);
    expect(stored.positiveCount).toBe(10);
    expect(stored.negativeCount).toBe(10);
    // …and logged as admin.action/risk_model_trained.
    const logged = mocks.logEvent.mock.calls.map((c) => c[0]);
    expect(logged.some(
      (e) =>
        e.type === "admin.action" &&
        (e.payload as Record<string, unknown>).action === "risk_model_trained",
    )).toBe(true);
  });

  it("PROMOTES when the signal is invisible to the heuristic (beats it on the holdout)", async () => {
    const { contracts, events } = buildBook("acq");
    mocks.contractFindMany.mockResolvedValue(contracts);
    mocks.eventFindMany.mockResolvedValue(events);

    const result = await runRiskLearning(SHOP, NOW);
    expect(result.trained).toBe(true);
    expect(result.promoted).toBe(true);
    expect(result.reason).toBe("promoted");
    expect(result.aucLearned).not.toBeNull();
    expect(result.aucHeuristic).not.toBeNull();
    expect(result.aucLearned! - result.aucHeuristic!).toBeGreaterThanOrEqual(
      PROMOTION_AUC_MARGIN,
    );
    // The heuristic is blind to the acquisition signal — near chance —
    // while the learned model separates it almost perfectly.
    expect(result.aucLearned!).toBeGreaterThan(0.9);
    expect(result.aucHeuristic!).toBeLessThan(0.6);

    const stored = await getSetting(SHOP, "riskModel");
    expect(stored.mode).toBe("learned");
    expect(stored.promoted).toBe(true);
    expect(stored.featureNames).toEqual([...RISK_FEATURE_NAMES]);
    expect(stored.weights).toHaveLength(RISK_FEATURE_NAMES.length);
    expect(stored.evaluation?.aucLearned).toBe(result.aucLearned);
  });

  it("stays in SHADOW when it cannot beat the heuristic by the margin", async () => {
    // The only churn signal is an open dunning case — the heuristic's own
    // strongest factor. Both scorers rank the holdout ~perfectly, the margin
    // is < PROMOTION_AUC_MARGIN, and the heuristic keeps the scorer.
    const { contracts, events } = buildBook("dunning");
    mocks.contractFindMany.mockResolvedValue(contracts);
    mocks.eventFindMany.mockResolvedValue(events);

    const result = await runRiskLearning(SHOP, NOW);
    expect(result.trained).toBe(true);
    expect(result.promoted).toBe(false);
    expect(result.reason).toContain("below_margin");
    expect(result.reason).toContain("shadow");
    expect(result.aucHeuristic!).toBeGreaterThan(0.9); // heuristic is genuinely good here
    expect(result.aucLearned! - result.aucHeuristic!).toBeLessThan(
      PROMOTION_AUC_MARGIN,
    );

    const stored = await getSetting(SHOP, "riskModel");
    expect(stored.mode).toBe("heuristic");
    expect(stored.promoted).toBe(false);
    // The shadow model's evaluation is still persisted (the audit trail).
    expect(stored.evaluation).not.toBeNull();
  });

  it("is deterministic end to end — two runs persist identical weights", async () => {
    const { contracts, events } = buildBook("acq");
    mocks.contractFindMany.mockResolvedValue(contracts);
    mocks.eventFindMany.mockResolvedValue(events);

    await runRiskLearning(SHOP, NOW);
    const first = await getSetting(SHOP, "riskModel");
    mocks.settingStore.clear();
    await runRiskLearning(SHOP, NOW);
    const second = await getSetting(SHOP, "riskModel");

    expect(second.weights).toEqual(first.weights);
    expect(second.means).toEqual(first.means);
    expect(second.stds).toEqual(first.stds);
    expect(second.intercept).toBe(first.intercept);
    expect(second.evaluation).toEqual(first.evaluation);
  });
});

// ── risk.server: promoted model vs heuristic fallback ────────────────────────

describe("runChurnRiskScoring — scorer selection", () => {
  function scoringContract(id: string, originTotalCents: number) {
    const old = new Date(NOW.getTime() - 200 * DAY);
    return {
      id,
      customerId: `gid://shopify/Customer/${id}`,
      email: `${id}@example.com`,
      intervalWeeks: 4,
      ordersCount: 5,
      skipCount: 0,
      consecutiveFailures: 0,
      lastSkippedAt: null,
      churnRiskScore: null,
      createdAt: old,
      firstChargeAt: old,
      originOrderTotalCents: originTotalCents,
      originOrderDiscountCents: 0,
    };
  }

  /** churnRiskScore written per contract id, from the batched updateMany calls. */
  function writtenScores(): Map<string, number> {
    const byId = new Map<string, number>();
    for (const call of mocks.contractUpdateMany.mock.calls) {
      const args = call[0] as {
        where: { id?: { in?: string[] } };
        data: { churnRiskScore?: number };
      };
      if (!args.where.id?.in) continue; // the stale-score hygiene write
      for (const id of args.where.id.in) {
        byId.set(id, args.data.churnRiskScore!);
      }
    }
    return byId;
  }

  it("falls back to the heuristic when no model was ever trained", async () => {
    mocks.contractFindMany.mockResolvedValue([scoringContract("c1", 8000)]);
    const result = await runChurnRiskScoring(SHOP, NOW);
    expect(result.scorer).toBe("heuristic");
  });

  it("scores with the learned model once one is promoted — and it uses the learned signal", async () => {
    const { contracts, events } = buildBook("acq");
    mocks.contractFindMany.mockResolvedValue(contracts);
    mocks.eventFindMany.mockResolvedValue(events);
    await runRiskLearning(SHOP, NOW);

    mocks.contractFindMany.mockResolvedValue([
      scoringContract("c_low", 500), // the churn profile the model learned
      scoringContract("c_high", 20_000),
    ]);
    mocks.eventFindMany.mockResolvedValue([]); // portal.login lookup

    const result = await runChurnRiskScoring(SHOP, NOW);
    expect(result.scorer).toBe("learned");
    expect(result.scored).toBe(2);

    const scores = writtenScores();
    // Identical heuristic inputs — only the acquisition signal differs, so a
    // heuristic scorer would write the SAME score for both. The learned model
    // must rank the tiny-first-order contract as riskier.
    expect(scores.get("c_low")!).toBeGreaterThan(scores.get("c_high")!);
    for (const s of scores.values()) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it("refuses a promoted model whose feature space no longer matches (fail-safe)", async () => {
    const { contracts, events } = buildBook("acq");
    mocks.contractFindMany.mockResolvedValue(contracts);
    mocks.eventFindMany.mockResolvedValue(events);
    await runRiskLearning(SHOP, NOW);

    // Corrupt the stored feature vocabulary (as a bad migration would).
    const row = mocks.settingStore.get(`${SHOP}:riskModel`)!;
    const value = row.value as { featureNames: string[] };
    value.featureNames = [...value.featureNames].reverse();

    mocks.contractFindMany.mockResolvedValue([scoringContract("c1", 500)]);
    mocks.eventFindMany.mockResolvedValue([]);
    const result = await runChurnRiskScoring(SHOP, NOW);
    expect(result.scorer).toBe("heuristic");
  });

  it("a trained-but-shadowed model never scores", async () => {
    const { contracts, events } = buildBook("dunning");
    mocks.contractFindMany.mockResolvedValue(contracts);
    mocks.eventFindMany.mockResolvedValue(events);
    await runRiskLearning(SHOP, NOW);

    mocks.contractFindMany.mockResolvedValue([scoringContract("c1", 8000)]);
    mocks.eventFindMany.mockResolvedValue([]);
    const result = await runChurnRiskScoring(SHOP, NOW);
    expect(result.scorer).toBe("heuristic");
  });
});

describe("getRiskModelStatus", () => {
  it("reports honest sample counts and the outcomes still needed", async () => {
    const { contracts, events } = buildBook("acq");
    mocks.contractFindMany.mockResolvedValue(contracts);
    mocks.eventFindMany.mockResolvedValue(events);
    const run = await runRiskLearning(SHOP, NOW);

    const status = await getRiskModelStatus(SHOP);
    expect(status.mode).toBe("learned");
    expect(status.samples).toBe(run.positives + run.negatives);
    expect(status.positives).toBe(run.positives);
    expect(status.auc).toBe(run.aucLearned);
    expect(status.outcomesNeeded).toBe(MIN_POSITIVE_OUTCOMES + MIN_NEGATIVE_OUTCOMES);
  });
});

// ── extractFeatures / heuristicRiskScore coherence ───────────────────────────

describe("extractFeatures", () => {
  const base: RiskFeatureInput = {
    openDunning: false,
    skippedLastCycle: false,
    ordersCount: 5,
    consecutiveFailures: 0,
    skipCount: 0,
    daysSinceLogin: null,
    accountAgeDays: 200,
    intervalWeeks: 4,
    acqRevenueCents: 8000,
    acqDiscountPct: 10,
  };

  it("always emits one value per RISK_FEATURE_NAMES entry", () => {
    expect(extractFeatures(base)).toHaveLength(RISK_FEATURE_NAMES.length);
  });

  it("encodes missing acquisition data explicitly instead of as zero revenue", () => {
    const withAcq = extractFeatures(base);
    const withoutAcq = extractFeatures({ ...base, acqRevenueCents: null });
    const presentIdx = RISK_FEATURE_NAMES.indexOf("acq_present");
    const revenueIdx = RISK_FEATURE_NAMES.indexOf("acq_revenue");
    expect(withAcq[presentIdx]).toBe(1);
    expect(withAcq[revenueIdx]).toBe(80);
    expect(withoutAcq[presentIdx]).toBe(0);
    expect(withoutAcq[revenueIdx]).toBe(0);
  });

  it("heuristicRiskScore ignores acquisition signals entirely (why promotion is winnable)", () => {
    expect(heuristicRiskScore(base)).toBe(
      heuristicRiskScore({ ...base, acqRevenueCents: 1, acqDiscountPct: 99 }),
    );
  });
});
