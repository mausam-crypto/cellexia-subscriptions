import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchesWhere, type Row } from "./helpers/analytics-db";

/**
 * Import re-run idempotency — the duplicate guard must cover EVERY status the
 * importer can create.
 *
 * The defect: processGroup's per-group guard matched only `status: "ACTIVE"`
 * local contracts, while the row schema explicitly accepts and creates
 * `PAUSED` ones. The standard migration workflow the SKIPPED_DUPLICATE status
 * exists to make safe — execute, vault the cards for the errored rows,
 * dry-run again, execute again — therefore re-fed every PAUSED group through
 * subscriptionContractAtomicCreate: each paused subscriber ended up with TWO
 * live PAUSED contracts on Shopify (and two OURS mirrors), billed twice per
 * cycle the moment they resume. The advisory-lock batch claim only serializes
 * CONCURRENT executes; it does nothing for this sequential re-run.
 *
 * The route action cannot be exercised without a database and a Shopify
 * session (the pattern pinned in tests/billing-ownership.test.ts), so this
 * pins the source THREE ways: the creatable set is a single constant, the
 * schema enum and the guard both derive from it, and the guard's where-clause
 * semantics are proven over the same interpreter the analytics tests use.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relative: string): string {
  return fs
    .readFileSync(path.join(ROOT, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const source = read("app/routes/app.import.tsx");
// The CLI importer is a SECOND surface with the same guard: the route was
// fixed first, the script kept a bare `status: "ACTIVE"` filter — so both
// sources are pinned to the identical constant + where-shape.
const scriptSource = read("scripts/import-subscribers.ts");

/** The creatable-status constant, parsed from an importer source. */
function importableStatusesIn(src: string): string[] {
  const m = src.match(
    /const IMPORTABLE_STATUSES\s*=\s*\[([^\]]*)\]\s*as const/,
  );
  expect(m, "IMPORTABLE_STATUSES constant must exist").toBeTruthy();
  return [...m![1].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]);
}

function importableStatuses(): string[] {
  return importableStatusesIn(source);
}

/** The duplicate-guard where-clause region of an importer source. */
function guardRegion(src: string, findFirstNeedle: string): string {
  const start = src.indexOf(findFirstNeedle);
  expect(start, `duplicate guard (${findFirstNeedle}) must exist`).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("SKIPPED_DUPLICATE", start));
}

describe("import duplicate guard covers the full creatable-status set", () => {
  it("the importer can create ACTIVE and PAUSED — both from one constant", () => {
    expect(importableStatuses().sort()).toEqual(["ACTIVE", "PAUSED"]);
    // The row schema derives from the SAME constant, so widening the enum
    // without widening the guard is no longer expressible.
    expect(source).toContain("z.enum(IMPORTABLE_STATUSES");
  });

  it("the duplicate findFirst filters on the constant, not a bare ACTIVE", () => {
    const guard = guardRegion(
      source,
      "const duplicate = await prisma.subscriptionContract.findFirst",
    );
    expect(guard).toContain("status: { in: [...IMPORTABLE_STATUSES] }");
    expect(guard).not.toContain('status: "ACTIVE"');
  });

  it("guard semantics: a PAUSED local contract IS a duplicate; a CANCELLED one is NOT", () => {
    // The exact where-shape processGroup issues, statuses taken from source.
    const where = {
      shopId: "shop_1",
      email: { equals: "sub@example.com", mode: "insensitive" },
      intervalWeeks: 4,
      status: { in: [...importableStatuses()] },
    };
    const row = (status: string): Row => ({
      shopId: "shop_1",
      email: "sub@example.com",
      intervalWeeks: 4,
      status,
    });

    // A re-executed file must skip BOTH statuses it could have created…
    expect(matchesWhere(row("ACTIVE"), where)).toBe(true);
    expect(matchesWhere(row("PAUSED"), where)).toBe(true);
    // …while a churned subscriber stays re-importable (behavior preserved).
    expect(matchesWhere(row("CANCELLED"), where)).toBe(false);
    expect(matchesWhere(row("EXPIRED"), where)).toBe(false);
    expect(matchesWhere(row("FAILED"), where)).toBe(false);
    // Same email, different cadence → a different subscription, not a dupe.
    expect(
      matchesWhere({ ...row("PAUSED"), intervalWeeks: 2 }, where),
    ).toBe(false);
  });

  it("guard semantics: the email match is CASE-INSENSITIVE (mirror keeps Shopify's case)", () => {
    // The chain that made the old case-sensitive guard a double-billing bug:
    // rowSchema lowercases every CSV email (the group key), while
    // syncContractFromShopify mirrors the Shopify customer's email VERBATIM —
    // the case the customer typed at checkout survives. A subscriber stored
    // as "John.Smith@Example.com" was therefore invisible to a guard
    // comparing against "john.smith@example.com", and the prescribed
    // "fix rows, re-run" pass created a SECOND live Shopify contract for
    // them (Shopify's customer search is case-insensitive, so processGroup
    // still found the customer): charged twice every interval. All-lowercase
    // subscribers were protected, mixed-case ones exposed — invisible in
    // small dry-run tests.
    const where = {
      shopId: "shop_1",
      email: { equals: "john.smith@example.com", mode: "insensitive" },
      intervalWeeks: 4,
      status: { in: [...importableStatuses()] },
    };
    const mirrorRow: Row = {
      shopId: "shop_1",
      email: "John.Smith@Example.com", // as Shopify stored it
      intervalWeeks: 4,
      status: "ACTIVE",
    };
    expect(matchesWhere(mirrorRow, where)).toBe(true);
    // …and a genuinely different subscriber still is not a duplicate.
    expect(
      matchesWhere({ ...mirrorRow, email: "jane.smith@example.com" }, where),
    ).toBe(false);
  });

  it("the route guard queries the email with the insensitive-equality shape", () => {
    const guard = guardRegion(
      source,
      "const duplicate = await prisma.subscriptionContract.findFirst",
    );
    expect(guard).toContain(
      'email: { equals: group.email, mode: "insensitive" }',
    );
    expect(guard).not.toContain("email: group.email,");
  });
});

describe("CLI importer (scripts/import-subscribers.ts) carries the same guard", () => {
  it("declares the identical creatable-status constant", () => {
    expect(importableStatusesIn(scriptSource).sort()).toEqual(
      importableStatuses().sort(),
    );
    // The row schema derives from the constant, so widening one without the
    // other is not expressible in either surface.
    expect(scriptSource).toContain("z.enum(IMPORTABLE_STATUSES");
  });

  it("processGroup's duplicate findFirst covers the constant, not a bare ACTIVE", () => {
    // Pre-fix this guard matched only ACTIVE, so the MIGRATION.md-prescribed
    // "fix the reported rows, re-run the file" pass re-created every PAUSED
    // group via subscriptionContractAtomicCreate: two live PAUSED Shopify
    // contracts per subscriber, both billing on resume.
    const guard = guardRegion(
      scriptSource,
      "const duplicate = await ctx.prisma.subscriptionContract.findFirst",
    );
    expect(guard).toContain("status: { in: [...IMPORTABLE_STATUSES] }");
    expect(guard).not.toContain('status: "ACTIVE"');
    // The skip verdict reports which status matched instead of asserting
    // "active" for a paused contract.
    expect(guard).toContain("status: true");
  });

  it("processGroup's duplicate findFirst matches the email case-insensitively too", () => {
    // Same double-import exposure as the route guard: the CLI pipeline
    // lowercases CSV emails while the mirror keeps Shopify's original case.
    const guard = guardRegion(
      scriptSource,
      "const duplicate = await ctx.prisma.subscriptionContract.findFirst",
    );
    expect(guard).toContain(
      'email: { equals: group.email, mode: "insensitive" }',
    );
    expect(guard).not.toContain("email: group.email,");
  });
});
