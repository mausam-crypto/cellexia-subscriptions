import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WHO GETS CHARGED — the query, evaluated.
 *
 * `tests/ownership-enforcement.test.ts` asserts *statically* that every gating
 * query still spreads `OURS_ONLY`, because a unit test with a mocked Prisma
 * cannot see a `where` clause the mock never interprets. That check is
 * necessary and not sufficient: it passes just as happily if `OURS_ONLY` is
 * redefined to `{}`, or to `{ ownership: { not: "FOREIGN" } }` — which would
 * still bill every UNKNOWN contract on the shop.
 *
 * This file closes that gap for the one query that moves money. It captures the
 * REAL `where` object the billing sweep hands Prisma and evaluates it against a
 * table of contracts that differ in exactly one field each — the mixed book the
 * client's store will have on go-live day: ours, Joy's (FOREIGN), and imports
 * whose plans could not be read (UNKNOWN). Only the OURS row may come back.
 *
 * The evaluator throws on any operator it does not implement, so a `where` that
 * grows a new condition fails loudly here instead of being silently ignored.
 */

// ── The captured queries ─────────────────────────────────────────────────────

interface Captured {
  contractFindMany: unknown[];
  attemptFindMany: unknown[];
}

const captured: Captured = { contractFindMany: [], attemptFindMany: [] };

const mocks = vi.hoisted(() => ({
  contractFindMany: vi.fn(async (_args: unknown): Promise<unknown[]> => []),
  attemptFindMany: vi.fn(async (_args: unknown): Promise<unknown[]> => []),
  attemptFindUnique: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  attemptUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  attemptCount: vi.fn(async (): Promise<number> => 0),
  attemptCreate: vi.fn(async (args: unknown): Promise<unknown> => args),
  contractUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  dunningCaseFindFirst: vi.fn(async (): Promise<unknown> => null),
  dunningCaseCreate: vi.fn(
    async (_args: unknown): Promise<unknown> => ({
      id: "case_1",
      contractId: "c_ours_due",
      state: "OPEN",
      declineCode: null,
      declineCategory: "SOFT",
      openedAt: new Date("2026-08-05T00:00:00Z"),
      retryCount: 0,
    }),
  ),
  dunningCaseUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({
    request: vi.fn(),
  })),
  logEvent: vi.fn(async (): Promise<void> => {}),
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "dunning") {
      return {
        softRetryDays: [0, 2, 5, 9],
        hardRetryDays: [],
        backupPaymentFallback: false,
        payday: { enabled: false, days: [] },
        maxRetries: 4,
      };
    }
    return {};
  }),
  sendNotification: vi.fn(async (): Promise<unknown> => ({ ok: true })),
  buildMagicUrl: vi.fn(async (): Promise<string> => "https://example.test/m"),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findMany: mocks.contractFindMany,
      update: mocks.contractUpdate,
    },
    billingAttempt: {
      findMany: mocks.attemptFindMany,
      findUnique: mocks.attemptFindUnique,
      // The engine's late-failure supersede check ("did this cycle already
      // succeed?"): none of these fixtures have a successful sibling attempt.
      findFirst: vi.fn(async () => null),
      update: mocks.attemptUpdate,
      // The failure engine's atomic entry claim: single invocation wins.
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: mocks.attemptCreate,
      count: mocks.attemptCount,
    },
    dunningCase: {
      findFirst: mocks.dunningCaseFindFirst,
      create: mocks.dunningCaseCreate,
      update: mocks.dunningCaseUpdate,
    },
    alert: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) },
  },
}));

vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: mocks.getPrimaryShop,
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: mocks.adminClientForShop,
}));
vi.mock("~/lib/events/log.server", () => ({
  logEvent: mocks.logEvent,
  EVENT_TYPES: {},
}));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: mocks.getSetting,
}));
vi.mock("~/lib/notifications/index.server", () => ({
  sendNotification: mocks.sendNotification,
}));
vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildMagicUrl: mocks.buildMagicUrl,
  buildPortalUrl: vi.fn(async () => "https://example.test/portal"),
  buildActionLinkBundle: vi.fn(async () => ({})),
}));

import {
  OURS_ONLY,
  isBillableOwnership,
  OWNERSHIP_FOREIGN,
  OWNERSHIP_OURS,
  OWNERSHIP_UNKNOWN,
} from "~/lib/ownership/ownership.server";
import {
  runBillingSweep,
  sweepStalePendingAttempts,
} from "~/lib/billing/scheduler.server";
import { onBillingAttemptFailed } from "~/lib/dunning/engine.server";

// ── A minimal, strict Prisma `where` evaluator ───────────────────────────────

const SCALAR_OPS = new Set([
  "equals",
  "not",
  "in",
  "notIn",
  "lt",
  "lte",
  "gt",
  "gte",
]);
const RELATION_OPS = new Set(["none", "some", "every", "is", "isNot"]);

type Row = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof Date) &&
    !Array.isArray(value)
  );
}

function compare(value: unknown, op: string, operand: unknown): boolean {
  const a = value instanceof Date ? value.getTime() : value;
  const b = operand instanceof Date ? operand.getTime() : operand;
  switch (op) {
    case "equals":
      return a === b;
    case "not":
      return operand === null ? value !== null && value !== undefined : a !== b;
    case "in":
      return Array.isArray(operand) && operand.includes(value);
    case "notIn":
      return Array.isArray(operand) && !operand.includes(value);
    case "lt":
      return a !== null && a !== undefined && (a as number) < (b as number);
    case "lte":
      return a !== null && a !== undefined && (a as number) <= (b as number);
    case "gt":
      return a !== null && a !== undefined && (a as number) > (b as number);
    case "gte":
      return a !== null && a !== undefined && (a as number) >= (b as number);
    /* c8 ignore next 2 */
    default:
      throw new Error(`unsupported operator: ${op}`);
  }
}

/**
 * Evaluate a Prisma `where` against one in-memory row. Deliberately supports
 * only what the swept queries actually use — anything else throws, so a query
 * that gains an unmodelled condition cannot quietly stop being tested.
 */
function matchesWhere(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === "AND") {
      const clauses = condition as Array<Record<string, unknown>>;
      if (!clauses.every((clause) => matchesWhere(row, clause))) return false;
      continue;
    }
    if (key === "OR") {
      const clauses = condition as Array<Record<string, unknown>>;
      if (!clauses.some((clause) => matchesWhere(row, clause))) return false;
      continue;
    }
    if (key === "NOT") {
      if (matchesWhere(row, condition as Record<string, unknown>)) return false;
      continue;
    }

    const value = row[key];

    if (!isPlainObject(condition)) {
      if (value !== condition) return false;
      continue;
    }

    const keys = Object.keys(condition);
    if (keys.length === 0) continue; // `{}` matches everything, as Prisma does

    if (keys.every((k) => SCALAR_OPS.has(k))) {
      for (const [op, operand] of Object.entries(condition)) {
        if (!compare(value, op, operand)) return false;
      }
      continue;
    }

    if (keys.every((k) => RELATION_OPS.has(k))) {
      for (const [op, operand] of Object.entries(condition)) {
        const filter = operand as Record<string, unknown>;
        if (op === "none" || op === "some" || op === "every") {
          const list = Array.isArray(value) ? (value as Row[]) : [];
          const hits = list.filter((item) => matchesWhere(item, filter));
          if (op === "none" && hits.length > 0) return false;
          if (op === "some" && hits.length === 0) return false;
          if (op === "every" && hits.length !== list.length) return false;
        } else {
          const related = isPlainObject(value) ? (value as Row) : {};
          const ok = matchesWhere(related, filter);
          if (op === "is" ? !ok : ok) return false;
        }
      }
      continue;
    }

    // A nested object filter on a to-one relation (`contract: { … }`).
    const related = isPlainObject(value) ? (value as Row) : {};
    if (!matchesWhere(related, condition)) return false;
  }
  return true;
}

function select(rows: Row[], where: Record<string, unknown>): string[] {
  return rows.filter((row) => matchesWhere(row, where)).map((r) => String(r.id));
}

// ── The mixed book on go-live day ────────────────────────────────────────────

const NOW = new Date("2026-08-05T09:00:00Z");
const YESTERDAY = new Date("2026-08-04T06:00:00Z");
const NEXT_MONTH = new Date("2026-09-05T06:00:00Z");

function contractRow(overrides: Row = {}): Row {
  return {
    id: "c_ours_due",
    shopId: "shop_1",
    ownership: OWNERSHIP_OURS,
    status: "ACTIVE",
    isDemo: false,
    nextBillingDate: YESTERDAY,
    // v1.28.0 (P3.8): no scheduled cancel — the sweep's due query excludes
    // contracts whose scheduled moment has passed.
    cancelScheduledAt: null,
    billingAttempts: [],
    ...overrides,
  };
}

/**
 * One row per reason a contract might or might not be charged. Everything but
 * the named field is identical to `c_ours_due`, so a selection difference can
 * only come from that field.
 */
const BOOK: Row[] = [
  contractRow(),
  contractRow({ id: "c_joy_due", ownership: OWNERSHIP_FOREIGN }),
  contractRow({ id: "c_unknown_due", ownership: OWNERSHIP_UNKNOWN }),
  contractRow({ id: "c_ours_demo", isDemo: true }),
  contractRow({ id: "c_ours_paused", status: "PAUSED" }),
  contractRow({ id: "c_ours_cancelled", status: "CANCELLED" }),
  contractRow({ id: "c_ours_not_due", nextBillingDate: NEXT_MONTH }),
  contractRow({ id: "c_ours_no_date", nextBillingDate: null }),
  contractRow({
    id: "c_ours_pending",
    billingAttempts: [{ status: "PENDING" }],
  }),
  contractRow({ id: "c_other_shop", shopId: "shop_2" }),
  // v1.28.0 (P3.8): a scheduled cancel whose moment has PASSED is never
  // billed (the customer was told "no charge after {date}", even if the
  // hourly cancel job is late); one still in the future bills as usual.
  contractRow({ id: "c_ours_cancel_passed", cancelScheduledAt: YESTERDAY }),
  contractRow({ id: "c_ours_cancel_future", cancelScheduledAt: NEXT_MONTH }),
];

beforeEach(() => {
  vi.clearAllMocks();
  captured.contractFindMany = [];
  captured.attemptFindMany = [];
  mocks.contractFindMany.mockImplementation(async (args: unknown) => {
    captured.contractFindMany.push(args);
    return [];
  });
  mocks.attemptFindMany.mockImplementation(async (args: unknown) => {
    captured.attemptFindMany.push(args);
    return [];
  });
  mocks.getPrimaryShop.mockResolvedValue({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  });
});

function dueWhere(): Record<string, unknown> {
  expect(captured.contractFindMany.length).toBeGreaterThan(0);
  const args = captured.contractFindMany[0] as { where: Record<string, unknown> };
  return args.where;
}

// ── The filter fragment itself ───────────────────────────────────────────────

describe("OURS_ONLY", () => {
  it("means exactly ownership = OURS — not 'anything but FOREIGN'", () => {
    // The static suite asserts this fragment is spread into every gating
    // query. This is what the fragment has to mean for that to be worth
    // anything: `{ ownership: { not: "FOREIGN" } }` would pass every static
    // check and still bill every UNKNOWN contract on the shop.
    expect(OURS_ONLY).toEqual({ ownership: "OURS" });
    expect(Object.keys(OURS_ONLY)).toEqual(["ownership"]);
  });

  it("agrees with the predicate the non-DB guards use", () => {
    // Two mechanisms, one rule: the `where` fragment (DB sweeps) and
    // isBillableOwnership() (in-process guards). If they ever disagree, a
    // contract is billable in one half of the app and not the other.
    for (const ownership of [
      OWNERSHIP_OURS,
      OWNERSHIP_FOREIGN,
      OWNERSHIP_UNKNOWN,
      null,
      "",
      "ours",
    ]) {
      expect(
        matchesWhere({ ownership }, { ...OURS_ONLY }),
        String(ownership),
      ).toBe(isBillableOwnership(ownership));
    }
  });
});

// ── The due-contract sweep ───────────────────────────────────────────────────

describe("the billing sweep's due-contract query", () => {
  it("selects ONLY the OURS contract out of a mixed book", async () => {
    await runBillingSweep(NOW);
    expect(select(BOOK, dueWhere()).sort()).toEqual(["c_ours_cancel_future", "c_ours_due"]);
  });

  it("excludes each non-billable row for its own reason", async () => {
    await runBillingSweep(NOW);
    const where = dueWhere();
    const selected = new Set(select(BOOK, where));

    // The two the ownership model exists for: Joy's contracts and the ones we
    // could not prove are ours. Charging either double-charges a real person.
    expect(selected.has("c_joy_due")).toBe(false);
    expect(selected.has("c_unknown_due")).toBe(false);
    // …and the pre-existing exclusions still hold.
    for (const id of [
      "c_ours_demo",
      "c_ours_paused",
      "c_ours_cancelled",
      "c_ours_not_due",
      "c_ours_no_date",
      "c_ours_pending",
      "c_other_shop",
      "c_ours_cancel_passed",
    ]) {
      expect(selected.has(id), id).toBe(false);
    }
    expect(selected.has("c_ours_cancel_future")).toBe(true);
  });

  it("REGRESSION (v1.22.0): the batch refetch re-applies the FULL due conditions", async () => {
    mocks.contractFindMany
      .mockImplementationOnce(async (args: unknown) => {
        captured.contractFindMany.push(args);
        return [{ id: "c_ours_due" }];
      })
      .mockImplementationOnce(async (args: unknown) => {
        captured.contractFindMany.push(args);
        return []; // cancelled/paused mid-sweep → the refetch drops it
      });

    await runBillingSweep(NOW);

    expect(captured.contractFindMany.length).toBe(2);
    const candidateWhere = (
      captured.contractFindMany[0] as { where: Record<string, unknown> }
    ).where;
    const batchWhere = (
      captured.contractFindMany[1] as { where: Record<string, unknown> }
    ).where;
    expect(batchWhere.id).toEqual({ in: ["c_ours_due"] });
    // A launch-scale sweep runs for minutes: a contract cancelled, paused,
    // reclassified or given an in-flight attempt AFTER the candidate scan
    // must drop out at its batch. Refetching by id + ownership alone would
    // bill it — every candidate guard must survive into the refetch.
    for (const key of [
      "shopId",
      "ownership",
      "status",
      "isDemo",
      "nextBillingDate",
      "billingAttempts",
    ]) {
      expect(batchWhere[key], key).toEqual(candidateWhere[key]);
    }
  });

  it("MUTATION GUARD: dropping the ownership key lets Joy's contract through", async () => {
    /* Every assertion above is "FOREIGN was not selected", which would also
       hold if some *other* clause happened to exclude those rows — or if the
       fixture rows were unselectable for an unrelated reason. Remove the
       ownership key from the captured `where` and the same evaluator, over the
       same rows, returns Joy's and the UNKNOWN import alongside ours: the
       duplicate-billing incident, reproduced against the real query. The
       ownership filter is the only thing preventing it. */
    await runBillingSweep(NOW);
    const { ownership, ...withoutOwnership } = dueWhere() as {
      ownership?: unknown;
    };
    expect(ownership).toBe(OWNERSHIP_OURS);
    expect(select(BOOK, withoutOwnership).sort()).toEqual([
      "c_joy_due",
      "c_ours_cancel_future",
      "c_ours_due",
      "c_unknown_due",
    ]);
  });

  it("re-reads the batch under the same restriction", async () => {
    // The sweep re-loads each batch with its lines before charging. That
    // second query is a second chance to lose the filter — and it is the one
    // whose rows actually reach the charge pipeline.
    mocks.contractFindMany
      .mockImplementationOnce(async (args: unknown) => {
        captured.contractFindMany.push(args);
        return [{ id: "c_ours_due" }];
      })
      .mockImplementationOnce(async (args: unknown) => {
        captured.contractFindMany.push(args);
        return [];
      });

    await runBillingSweep(NOW);

    expect(captured.contractFindMany).toHaveLength(2);
    const batch = (captured.contractFindMany[1] as { where: Record<string, unknown> })
      .where;
    expect(batch).toMatchObject({ ownership: OWNERSHIP_OURS });
    expect(
      select(
        [
          contractRow({ id: "c_ours_due" }),
          contractRow({ id: "c_joy_due", ownership: OWNERSHIP_FOREIGN }),
          contractRow({ id: "c_unknown_due", ownership: OWNERSHIP_UNKNOWN }),
        ],
        batch,
      ),
    ).toEqual(["c_ours_due"]);
  });

  it("charges nothing at all when the whole book is another app's", async () => {
    // The client's store today: Joy's subscribers mirrored in, none of ours
    // live yet. The sweep must be a no-op — no admin call, no attempt.
    mocks.contractFindMany.mockImplementation(async (args: unknown) => {
      captured.contractFindMany.push(args);
      return select(BOOK, (args as { where: Record<string, unknown> }).where)
        .filter((id) => id !== "c_ours_due" && id !== "c_ours_cancel_future")
        .map((id) => ({ id }));
    });

    const stats = await runBillingSweep(NOW);
    expect(stats.attempted).toBe(0);
    expect(stats.scanned).toBe(0);
  });
});

// ── The stale-attempt sweep ──────────────────────────────────────────────────

describe("the stale pending-attempt sweep", () => {
  it("resolves only attempts belonging to our own contracts", async () => {
    await sweepStalePendingAttempts(2);

    expect(captured.attemptFindMany.length).toBeGreaterThan(0);
    const where = (captured.attemptFindMany[0] as {
      where: Record<string, unknown>;
    }).where;

    const OLD = new Date("2026-01-01T00:00:00Z");
    // The sweep's cutoff is `new Date()` minus the age argument, so "fresh"
    // has to be relative to the real clock, not to a fixture date.
    const FRESH = new Date(Date.now() - 60_000);
    const attempts: Row[] = [
      {
        id: "a_ours",
        status: "PENDING",
        startedAt: OLD,
        scheduledFor: OLD,
        contract: contractRow(),
      },
      {
        id: "a_joy",
        status: "PENDING",
        startedAt: OLD,
        scheduledFor: OLD,
        contract: contractRow({ ownership: OWNERSHIP_FOREIGN }),
      },
      {
        id: "a_unknown",
        status: "PENDING",
        startedAt: OLD,
        scheduledFor: OLD,
        contract: contractRow({ ownership: OWNERSHIP_UNKNOWN }),
      },
      {
        id: "a_ours_demo",
        status: "PENDING",
        startedAt: OLD,
        scheduledFor: OLD,
        contract: contractRow({ isDemo: true }),
      },
      {
        id: "a_ours_done",
        status: "SUCCEEDED",
        startedAt: OLD,
        scheduledFor: OLD,
        contract: contractRow(),
      },
      {
        id: "a_ours_fresh",
        status: "PENDING",
        startedAt: FRESH,
        scheduledFor: FRESH,
        contract: contractRow(),
      },
    ];

    expect(select(attempts, where)).toEqual(["a_ours"]);

    // …and without the nested ownership filter, the other apps' attempts come
    // back — this sweep can FAIL or EXPIRE what it selects.
    const contractFilter = { ...(where.contract as Record<string, unknown>) };
    delete contractFilter.ownership;
    expect(
      select(attempts, { ...where, contract: contractFilter }).sort(),
    ).toEqual(["a_joy", "a_ours", "a_unknown"]);
  });
});

// ── Dunning: a foreign decline is not our case to open ───────────────────────

/**
 * A FOREIGN contract can still reach the dunning engine: Shopify sends
 * SUBSCRIPTION_BILLING_ATTEMPTS_FAILURE for the OTHER app's charges too, and
 * the mirror stores them. Opening a case means promising to retry the charge
 * and to email the customer about their card — for a subscription the customer
 * bought from someone else.
 */
describe("the dunning case-creation guard", () => {
  function attemptFixture(ownership: string): Row {
    return {
      id: "att_1",
      contractId: "c_1",
      status: "PENDING",
      declineCategory: null,
      errorCode: "insufficient_funds", // SOFT
      cycleIndex: 3,
      attemptNumber: 1,
      completedAt: null,
      usedBackupPayment: false,
      mitEvidence: null,
      contract: {
        id: "c_1",
        shopId: "shop_1",
        ownership,
        status: "ACTIVE",
        isDemo: false,
        email: "anna@example.com",
        locale: "en",
        currencyCode: "CHF",
        shopifyContractId: "gid://shopify/SubscriptionContract/1",
        customerId: "gid://shopify/Customer/1",
        consecutiveFailures: 0,
        paymentMethodId: "gid://shopify/CustomerPaymentMethod/1",
        backupPaymentMethodId: null,
        nextBillingDate: YESTERDAY,
        shop: { id: "shop_1", domain: "cellexia.myshopify.com", ianaTimezone: "Europe/Zurich" },
        lines: [],
      },
    };
  }

  it.each([
    ["FOREIGN", OWNERSHIP_FOREIGN],
    ["UNKNOWN", OWNERSHIP_UNKNOWN],
  ])("opens no case, writes nothing and sends nothing for a %s contract", async (
    _label,
    ownership,
  ) => {
    mocks.attemptFindUnique.mockResolvedValue(attemptFixture(ownership));

    await onBillingAttemptFailed("att_1");

    expect(mocks.dunningCaseCreate).not.toHaveBeenCalled();
    expect(mocks.dunningCaseFindFirst).not.toHaveBeenCalled();
    // Not even the attempt row is touched: the guard is the first thing past
    // the load, before any write.
    expect(mocks.attemptUpdate).not.toHaveBeenCalled();
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("VACUITY GUARD: the identical failure DOES open a case when it is ours", async () => {
    // Same attempt, same decline code, one field different. Without this the
    // test above would pass against an engine that never opens a case at all.
    mocks.attemptFindUnique.mockResolvedValue(attemptFixture(OWNERSHIP_OURS));

    await onBillingAttemptFailed("att_1").catch(() => {
      /* The retry ladder past case-creation is covered by
         tests/dunning-ladder.test.ts and needs the full Shopify surface; what
         matters here is that the ownership guard let the call through. */
    });

    expect(mocks.attemptUpdate).toHaveBeenCalled();
    expect(mocks.dunningCaseCreate).toHaveBeenCalled();
  });
});

// ── The other direction: OUR subscribers must not fall out of the sweep ──────

/**
 * Every test above is about not charging someone else's subscriber. The
 * mirror-image failure is quieter and just as real: an imported subscriber
 * that lands as UNKNOWN is never charged again, and nothing anywhere raises a
 * hand about it.
 *
 * `subscriptionContractAtomicCreate` imports carry NO selling plan, so the
 * line-based classifier can only ever return UNKNOWN for them. The import
 * paths must therefore stamp OURS themselves — they are the one place with
 * positive evidence (we created the contract). These live in a CLI script and
 * a Remix action, neither of which can be exercised without a database and a
 * Shopify session, so the stamp is pinned in the source.
 */
describe("contracts we create ourselves are stamped OURS", () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  function read(relative: string): string {
    return fs
      .readFileSync(path.join(ROOT, relative), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  }

  it("the import script stamps both branches of its upsert", () => {
    const source = read("scripts/import-subscribers.ts");
    const upsert = source.slice(
      source.indexOf("prisma.subscriptionContract.upsert"),
    );
    const create = upsert.slice(upsert.indexOf("create:"), upsert.indexOf("update:"));
    const update = upsert.slice(upsert.indexOf("update:"));
    expect(create).toContain('ownership: "OURS"');
    // The update branch matters just as much: re-running the import over a
    // contract the webhook mirror already filed as UNKNOWN must repair it.
    expect(update.slice(0, update.indexOf("});"))).toContain('ownership: "OURS"');
  });

  it("the admin import route stamps its create AND repairs the mirrored row", () => {
    const source = read("app/routes/app.import.tsx");
    const create = source.slice(
      source.indexOf("prisma.subscriptionContract.create"),
    );
    expect(create.slice(0, create.indexOf("lines:"))).toContain(
      'ownership: "OURS"',
    );
    // The route calls syncContractFromShopify first, which files the row as
    // UNKNOWN (an import has no selling plan). Without this repair the
    // just-imported subscriber is unbillable forever.
    expect(source).toContain('local.ownership !== "OURS"');
    const repair = source.slice(source.indexOf('local.ownership !== "OURS"'));
    expect(repair.slice(0, repair.indexOf("await logEvent"))).toContain(
      'ownership: "OURS"',
    );
  });
});
