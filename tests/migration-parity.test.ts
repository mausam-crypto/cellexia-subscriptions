import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * DO THE MIGRATIONS ACTUALLY BUILD THE SCHEMA?
 *
 * `prisma validate` checks that schema.prisma parses. It says nothing about
 * whether replaying 0001+0002+0003 produces that schema — and the migrations
 * are the only thing that ever runs on the client's database (`npm run setup`
 * is `prisma generate && prisma migrate deploy`). A field added to
 * schema.prisma without its migration passes validate, passes typecheck,
 * passes every mocked unit test in this suite, and then fails on the client's
 * store at install time with "column does not exist" — after the app is live.
 *
 * That is exactly the shape of the ownership work: `ownership`,
 * `shopifyPlanIds`, `sellingPlanId` and `sellingPlanName` are all new columns
 * that every ownership guard reads. If migration 0003 missed one, every guard
 * in this suite would still pass (Prisma is mocked) and billing would break on
 * the real database.
 *
 * So this replays the migration chain as text and checks it against the models
 * in schema.prisma. No database and no Prisma CLI: it is a parser, so it runs
 * in milliseconds and works in any CI.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ── The migration chain, replayed ────────────────────────────────────────────

/** Comment-free, whitespace-normalised statements, in order. */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function migrationDirs(): string[] {
  const dir = path.join(ROOT, "prisma/migrations");
  return fs
    .readdirSync(dir)
    .filter((d) => fs.statSync(path.join(dir, d)).isDirectory())
    .sort();
}

/** Columns each table has after the whole chain has run. */
function replayColumns(stmts: string[]): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();

  for (const s of stmts) {
    const create = /^CREATE TABLE (?:IF NOT EXISTS )?"([^"]+)" \((.*)\)$/i.exec(s);
    if (create) {
      const cols = new Set<string>();
      // Split on top-level commas only: types like DECIMAL(10,2) nest.
      let depth = 0;
      let cur = "";
      const parts: string[] = [];
      for (const ch of create[2]) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (ch === "," && depth === 0) {
          parts.push(cur);
          cur = "";
        } else cur += ch;
      }
      if (cur.trim()) parts.push(cur);
      for (const p of parts) {
        const c = /^\s*"([^"]+)"\s+\S/.exec(p);
        if (c && !/^\s*CONSTRAINT/i.test(p)) cols.add(c[1]);
      }
      tables.set(create[1], cols);
      continue;
    }

    const alter = /^ALTER TABLE "([^"]+)" (.*)$/i.exec(s);
    if (alter) {
      const cols = tables.get(alter[1]) ?? new Set<string>();
      for (const add of alter[2].matchAll(/ADD COLUMN\s+"([^"]+)"/gi)) {
        cols.add(add[1]);
      }
      for (const drop of alter[2].matchAll(/DROP COLUMN\s+"([^"]+)"/gi)) {
        cols.delete(drop[1]);
      }
      tables.set(alter[1], cols);
    }
  }
  return tables;
}

// ── schema.prisma, parsed ────────────────────────────────────────────────────

const PRISMA_SCALARS = new Set([
  "String",
  "Boolean",
  "Int",
  "BigInt",
  "Float",
  "Decimal",
  "DateTime",
  "Json",
  "Bytes",
]);

interface Model {
  /** Table name (@@map wins over the model name). */
  table: string;
  /** Column names (@map wins over the field name). */
  columns: Set<string>;
}

function parseSchema(src: string): Model[] {
  const enums = new Set(
    [...src.matchAll(/^enum\s+(\w+)\s*\{/gm)].map((m) => m[1]),
  );
  const modelNames = new Set(
    [...src.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]),
  );

  const models: Model[] = [];
  for (const block of src.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, name, body] = block;
    let table = name;
    const columns = new Set<string>();

    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("//")) continue;

      const mapped = /^@@map\("([^"]+)"\)/.exec(line);
      if (mapped) {
        table = mapped[1];
        continue;
      }
      if (line.startsWith("@@")) continue; // @@index / @@unique / @@id

      const field = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
      if (!field) continue;
      const [, fieldName, type, list, , attrs] = field;

      // Relation fields are not columns; their scalar FK (`shopId`) is a
      // separate field and is picked up on its own line.
      if (modelNames.has(type)) continue;
      // Scalar lists are columns, but a list of an unknown type is not.
      if (!PRISMA_SCALARS.has(type) && !enums.has(type)) continue;
      if (list && !PRISMA_SCALARS.has(type) && !enums.has(type)) continue;

      const renamed = /@map\("([^"]+)"\)/.exec(attrs);
      columns.add(renamed ? renamed[1] : fieldName);
    }
    models.push({ table, columns });
  }
  return models;
}

// ── The checks ───────────────────────────────────────────────────────────────

const chain = migrationDirs().flatMap((d) =>
  statements(read(`prisma/migrations/${d}/migration.sql`)),
);
const built = replayColumns(chain);
const models = parseSchema(read("prisma/schema.prisma"));

describe("the migrations build the schema the app is compiled against", () => {
  it("parses a believable amount of both sides (guards the parsers themselves)", () => {
    // If either parser silently produced nothing, every assertion below would
    // pass vacuously.
    expect(models.length).toBeGreaterThan(20);
    expect(built.size).toBeGreaterThan(20);
    for (const model of models) {
      expect(model.columns.size, `${model.table} has no columns`).toBeGreaterThan(0);
    }
  });

  it("creates a table for every model", () => {
    const missing = models
      .filter((m) => !built.has(m.table))
      .map((m) => m.table);
    expect(missing, `models with no CREATE TABLE: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("creates a column for every scalar field", () => {
    const missing: string[] = [];
    for (const model of models) {
      const cols = built.get(model.table);
      if (!cols) continue;
      for (const col of model.columns) {
        if (!cols.has(col)) missing.push(`${model.table}.${col}`);
      }
    }
    expect(
      missing,
      `fields in schema.prisma with no column in any migration: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("leaves no column behind that the schema no longer has", () => {
    const orphans: string[] = [];
    const byTable = new Map(models.map((m) => [m.table, m.columns]));
    for (const [table, cols] of built) {
      const fields = byTable.get(table);
      if (!fields) {
        orphans.push(`${table} (whole table)`);
        continue;
      }
      for (const col of cols) {
        if (!fields.has(col)) orphans.push(`${table}.${col}`);
      }
    }
    expect(
      orphans,
      `columns the migrations create that schema.prisma does not declare: ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  /**
   * The four columns the whole ownership guard rests on. Named explicitly so
   * that if one is ever dropped from the migration the failure says which
   * safety property just lost its storage, rather than "some column missing".
   */
  it("has storage for every column the ownership guards read", () => {
    expect(built.get("SubscriptionContract")).toContain("ownership");
    expect(built.get("SellingPlanConfig")).toContain("shopifyPlanIds");
    expect(built.get("ContractLine")).toContain("sellingPlanId");
    expect(built.get("ContractLine")).toContain("sellingPlanName");
  });
});

/**
 * MIGRATED BOOKS MUST NOT COHORT ON IMPORT DAY.
 *
 * Every arrival/cohort surface anchors on `firstChargeAt ?? createdAt`.
 * Imported contracts have no origin order, so nothing backfills
 * firstChargeAt for them — without a signup-date column in the CSV, an
 * entire migrated book lands as one giant import-day cohort (newSubscribers
 * spike, wrong cohort triangle, accountAgeDays = days-since-import), and the
 * real signup date exists ONLY in the source platform's export at import
 * time: skip collecting it once and it is gone forever. These are text-level
 * pins (same technique as the chain replay above): both importers must keep
 * accepting `subscribed_since` and writing it into `firstChargeAt`, and the
 * cohort anchors must keep reading that column.
 */
describe("imported subscribers cohort on subscribed_since, not import day", () => {
  const importers = [
    "scripts/import-subscribers.ts",
    "app/routes/app.import.tsx",
  ] as const;

  it("both importers accept subscribed_since and write firstChargeAt", () => {
    for (const rel of importers) {
      const source = read(rel);
      expect(source, `${rel} lost the subscribed_since column`).toContain(
        "subscribed_since",
      );
      expect(source, `${rel} no longer writes firstChargeAt`).toContain(
        "firstChargeAt: subscribedSince",
      );
      // Idempotency: an already-stamped instant (re-run, first renewal) is
      // never overwritten by a CSV value.
      expect(source).toContain("local.firstChargeAt == null");
    }
  });

  it("the migration chain has storage for the anchor column", () => {
    expect(built.get("SubscriptionContract")).toContain("firstChargeAt");
  });

  it("the cohort/arrival anchors read the column the importers fill", () => {
    for (const rel of [
      "app/lib/analytics/cohorts.server.ts",
      "app/lib/analytics/rollup.server.ts",
      "app/lib/analytics/queries.server.ts",
    ]) {
      expect(read(rel), `${rel} no longer anchors on firstChargeAt`).toContain(
        "firstChargeAt",
      );
    }
  });
});
