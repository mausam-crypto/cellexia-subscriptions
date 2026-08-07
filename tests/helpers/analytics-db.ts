/**
 * In-memory Prisma stand-in for the analytics golden-number tests.
 *
 * The real engines (rollup / cohorts / survival / cost coverage) run
 * unmodified; only `~/db.server` is swapped for this interpreter. Unlike a
 * canned-response mock, it APPLIES the `where` clauses the engines actually
 * send — scalar equality, in / notIn / not / gte / gt / lte / lt, OR / AND /
 * NOT, nested relation objects ({ contract: { ownership: "OURS", … } }) and
 * JSON path filters — against plain-object rows. A query that silently loses a
 * filter (ownership, currency, status, demo) therefore CHANGES the numbers and
 * fails the golden assertions; a fixed-return mock could never catch that
 * class of bug.
 *
 * Supported surface: exactly what app/lib/analytics/* calls today. Unknown
 * operators throw so a new query shape fails loudly instead of matching
 * wrongly.
 *
 * Conventions:
 * - Relations are EMBEDDED on the row (a billing attempt carries its full
 *   `contract` object, a gift grant its `rule`). Relation `where` filters
 *   recurse into the embedded object; `select`/`include` are ignored (returning
 *   extra fields is harmless to the code under test).
 * - `Setting` rows are served to the real `getSetting`, so cost-model values
 *   flow through the genuine zod parsing path.
 */

import { Prisma } from "@prisma/client";

export type Row = Record<string, unknown>;

export interface AnalyticsStore {
  shops: Row[];
  settings: Row[];
  subscriptionContracts: Row[];
  billingAttempts: Row[];
  subscriberEvents: Row[];
  giftGrants: Row[];
  discountGrants: Row[];
  dunningCases: Row[];
  productCadences: Row[];
  dailyRollups: Row[];
  cohortCells: Row[];
  cancelSessions: Row[];
  alerts: Row[];
}

export function emptyStore(): AnalyticsStore {
  return {
    shops: [],
    settings: [],
    subscriptionContracts: [],
    billingAttempts: [],
    subscriberEvents: [],
    giftGrants: [],
    discountGrants: [],
    dunningCases: [],
    productCadences: [],
    dailyRollups: [],
    cohortCells: [],
    cancelSessions: [],
    alerts: [],
  };
}

// ── Where-clause interpreter ──────────────────────────────────────────────────

const OPS = new Set([
  "equals",
  "in",
  "notIn",
  "not",
  "gte",
  "gt",
  "lte",
  "lt",
  "contains",
  "startsWith",
  "endsWith",
  // String-filter modifier, not an operator: `mode: "insensitive"` folds case
  // for the sibling operators (Prisma's citext-style match — the shape the
  // import duplicate guards and the portal OTP lookup use).
  "mode",
]);

function eq(a: unknown, b: unknown, insensitive = false): boolean {
  if (a instanceof Date || b instanceof Date) {
    return (
      a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
    );
  }
  if (insensitive && typeof a === "string" && typeof b === "string") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/** Orderable projection for gte/gt/lte/lt and sorting. */
function ord(v: unknown): number | string {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number" || typeof v === "string") return v;
  throw new Error(`[analytics-db] unorderable value: ${String(v)}`);
}

function matchesCondition(value: unknown, cond: unknown): boolean {
  if (cond === null) return value == null;
  if (cond instanceof Date || typeof cond !== "object") return eq(value, cond);
  if (Array.isArray(cond)) {
    throw new Error("[analytics-db] bare array condition unsupported");
  }
  const c = cond as Row;

  // JSON path filter: { path: ["action"], equals: "refund_recorded" }
  if ("path" in c) {
    let v: unknown = value;
    for (const p of c.path as string[]) {
      v = v != null && typeof v === "object" ? (v as Row)[p] : undefined;
    }
    if ("equals" in c) return v === c.equals;
    throw new Error("[analytics-db] unsupported JSON filter (only equals)");
  }

  // Relation filter: { is: { … } }
  if ("is" in c) {
    return value != null && matchesWhere(value as Row, c.is);
  }

  const keys = Object.keys(c);
  if (keys.every((k) => OPS.has(k))) {
    const insensitive = c.mode === "insensitive";
    for (const k of keys) {
      const op = c[k];
      switch (k) {
        case "mode":
          break; // modifier consumed above, not a comparison of its own
        case "equals":
          // Prisma's JSON-null sentinels: `{ equals: Prisma.AnyNull }` /
          // `{ equals: Prisma.DbNull }` match a column holding no value (the
          // shape the acqRaw-still-null claims use).
          if (op === Prisma.AnyNull || op === Prisma.DbNull) {
            if (value != null) return false;
            break;
          }
          if (insensitive) {
            if (!eq(value, op, true)) return false;
            break;
          }
          if (!matchesCondition(value, op)) return false;
          break;
        case "in":
          if (!(op as unknown[]).some((x) => eq(value, x, insensitive)))
            return false;
          break;
        case "notIn":
          if ((op as unknown[]).some((x) => eq(value, x, insensitive)))
            return false;
          break;
        case "not":
          if (op === null) {
            if (value == null) return false;
          } else if (matchesCondition(value, op)) return false;
          break;
        case "gte":
        case "gt":
        case "lte":
        case "lt": {
          if (value == null) return false;
          const a = ord(value);
          const b = ord(op);
          if (k === "gte" && !(a >= b)) return false;
          if (k === "gt" && !(a > b)) return false;
          if (k === "lte" && !(a <= b)) return false;
          if (k === "lt" && !(a < b)) return false;
          break;
        }
        default:
          throw new Error(`[analytics-db] unsupported operator ${k}`);
      }
    }
    return true;
  }

  // Plain nested object → embedded relation filter ({ contract: { shopId, … } }).
  if (Array.isArray(value)) {
    throw new Error("[analytics-db] relation-list filters unsupported");
  }
  return (
    value != null && typeof value === "object" && matchesWhere(value as Row, c)
  );
}

export function matchesWhere(row: Row, where: unknown): boolean {
  if (where == null) return true;
  for (const [key, cond] of Object.entries(where as Row)) {
    if (cond === undefined) continue;
    if (key === "AND") {
      for (const c of cond as Row[]) if (!matchesWhere(row, c)) return false;
      continue;
    }
    if (key === "OR") {
      if (!(cond as Row[]).some((c) => matchesWhere(row, c))) return false;
      continue;
    }
    if (key === "NOT") {
      if (matchesWhere(row, cond)) return false;
      continue;
    }
    if (!matchesCondition(row[key], cond)) return false;
  }
  return true;
}

/** `{ shopId_key: { shopId, key } }` → `{ shopId, key }` (compound uniques). */
function flattenUniqueWhere(where: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(where)) {
    if (
      v != null &&
      typeof v === "object" &&
      !(v instanceof Date) &&
      k.includes("_")
    ) {
      Object.assign(out, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Apply an update `data` object: plain sets plus increment/decrement. */
function applyUpdateData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (v != null && typeof v === "object" && !(v instanceof Date)) {
      const op = v as Row;
      if ("increment" in op) {
        row[k] = ((row[k] as number) ?? 0) + (op.increment as number);
        continue;
      }
      if ("decrement" in op) {
        row[k] = ((row[k] as number) ?? 0) - (op.decrement as number);
        continue;
      }
      if ("set" in op) {
        row[k] = op.set;
        continue;
      }
    }
    row[k] = v;
  }
}

function applyOrderBy(rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows;
  const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Row[];
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      for (const [field, dirRaw] of Object.entries(spec)) {
        const dir =
          typeof dirRaw === "string" ? dirRaw : ((dirRaw as Row).sort as string);
        const av = a[field];
        const bv = b[field];
        if (av == null && bv == null) continue;
        if (av == null) return 1; // nulls last
        if (bv == null) return -1;
        const ao = ord(av);
        const bo = ord(bv);
        const cmp = ao < bo ? -1 : ao > bo ? 1 : 0;
        if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
      }
    }
    return 0;
  });
}

// ── Model factory ─────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
type Args = Record<string, any>;

function makeTable(store: AnalyticsStore, name: keyof AnalyticsStore) {
  const rows = () => store[name];
  const filtered = (where: unknown) => rows().filter((r) => matchesWhere(r, where));
  return {
    findMany: async (args: Args = {}) =>
      applyOrderBy(filtered(args.where), args.orderBy),
    findFirst: async (args: Args = {}) =>
      applyOrderBy(filtered(args.where), args.orderBy)[0] ?? null,
    findUnique: async (args: Args) =>
      rows().find((r) => matchesWhere(r, flattenUniqueWhere(args.where))) ?? null,
    findUniqueOrThrow: async (args: Args) => {
      const row = rows().find((r) =>
        matchesWhere(r, flattenUniqueWhere(args.where)),
      );
      if (!row) throw new Error(`[analytics-db] ${name}: no row for findUniqueOrThrow`);
      return row;
    },
    count: async (args: Args = {}) => filtered(args.where).length,
    groupBy: async (args: Args) => {
      const by = args.by as string[];
      const map = new Map<string, Row>();
      for (const row of filtered(args.where)) {
        const key = by.map((f) => JSON.stringify(row[f] ?? null)).join("␟");
        let g = map.get(key);
        if (!g) {
          g = { _count: { _all: 0 } };
          for (const f of by) g[f] = row[f] ?? null;
          map.set(key, g);
        }
        (g._count as { _all: number })._all += 1;
      }
      return [...map.values()];
    },
    aggregate: async (args: Args) => {
      const matched = filtered(args.where);
      const out: Row = {};
      if (args._sum) {
        const sums: Row = {};
        for (const field of Object.keys(args._sum)) {
          sums[field] =
            matched.length === 0
              ? null
              : matched.reduce(
                  (total, r) => total + (((r[field] as number) ?? 0) as number),
                  0,
                );
        }
        out._sum = sums;
      }
      if (args._count) out._count = { _all: matched.length };
      return out;
    },
    create: async (args: Args) => {
      const row = { ...(args.data as Row) };
      rows().push(row);
      return row;
    },
    update: async (args: Args) => {
      const row = rows().find((r) =>
        matchesWhere(r, flattenUniqueWhere(args.where)),
      );
      if (!row) throw new Error(`[analytics-db] ${name}: no row for update`);
      applyUpdateData(row, args.data as Row);
      return row;
    },
    updateMany: async (args: Args = {}) => {
      const matched = filtered(args.where);
      for (const row of matched) applyUpdateData(row, args.data as Row);
      return { count: matched.length };
    },
    createMany: async (args: Args) => {
      const data = args.data as Row[];
      for (const d of data) rows().push({ ...d });
      return { count: data.length };
    },
    deleteMany: async (args: Args = {}) => {
      const keep = rows().filter((r) => !matchesWhere(r, args.where));
      const removed = rows().length - keep.length;
      rows().length = 0;
      rows().push(...keep);
      return { count: removed };
    },
    upsert: async (args: Args) => {
      const where = flattenUniqueWhere(args.where);
      const existing = rows().find((r) => matchesWhere(r, where));
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const created = { ...(args.create as Row) };
      rows().push(created);
      return created;
    },
  };
}

/** Build the prisma-shaped client over a mutable store. */
export function createAnalyticsDb(store: AnalyticsStore) {
  const client = {
    shop: makeTable(store, "shops"),
    setting: makeTable(store, "settings"),
    subscriptionContract: makeTable(store, "subscriptionContracts"),
    billingAttempt: makeTable(store, "billingAttempts"),
    subscriberEvent: makeTable(store, "subscriberEvents"),
    giftGrant: makeTable(store, "giftGrants"),
    discountGrant: makeTable(store, "discountGrants"),
    dunningCase: makeTable(store, "dunningCases"),
    productCadence: makeTable(store, "productCadences"),
    dailyRollup: makeTable(store, "dailyRollups"),
    cohortCell: makeTable(store, "cohortCells"),
    cancelSession: makeTable(store, "cancelSessions"),
    alert: makeTable(store, "alerts"),
    $transaction: async (ops: unknown) =>
      Array.isArray(ops)
        ? Promise.all(ops)
        : (ops as (c: unknown) => unknown)(client),
  };
  return client;
}

export type FakeDb = ReturnType<typeof createAnalyticsDb>;
