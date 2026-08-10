import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchesWhere, type Row } from "./helpers/analytics-db";
import { contractFrequency, frequencyToken, type Frequency } from "~/lib/frequency";

/**
 * Import re-run idempotency — the duplicate guard must cover EVERY status the
 * importer can create, and (since v1.8.0) compare the CADENCE, not a week
 * approximation.
 *
 * The original defect: processGroup's per-group guard matched only
 * `status: "ACTIVE"` local contracts, while the row schema explicitly accepts
 * and creates `PAUSED` ones. The standard migration workflow the
 * SKIPPED_DUPLICATE status exists to make safe — execute, vault the cards for
 * the errored rows, dry-run again, execute again — therefore re-fed every
 * PAUSED group through subscriptionContractAtomicCreate: each paused
 * subscriber ended up with TWO live PAUSED contracts on Shopify (and two OURS
 * mirrors), billed twice per cycle the moment they resume. The advisory-lock
 * batch claim only serializes CONCURRENT executes; it does nothing for this
 * sequential re-run.
 *
 * v1.8.0 moved the cadence comparison out of the where-clause into JS: the
 * guard fetches every importable-status contract for the email and matches
 * `frequencyToken(contractFrequency(candidate))` against the group's token.
 * That is what lets a pre-v1.8.0 mirror (week approximation only) and a
 * post-v1.8.0 mirror (exact unit+count) both compare correctly — and what
 * keeps "10 days" and "2 weeks" DISTINCT even though approxWeeks maps both
 * to 2 (an approximation collision is not identity; treating it as one would
 * silently skip a genuinely new subscription).
 *
 * The route action cannot be exercised without a database and a Shopify
 * session (the pattern pinned in tests/billing-ownership.test.ts), so this
 * pins the source THREE ways: the creatable set is a single constant, the
 * schema enum and the guard both derive from it, and the guard's where-clause
 * semantics are proven over the same interpreter the analytics tests use —
 * with the token comparison proven over the REAL frequency module.
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
// sources are pinned to the identical constant + guard shape.
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

/** The duplicate-guard region (candidate fetch + token match) of a source. */
function guardRegion(src: string, findManyNeedle: string): string {
  const start = src.indexOf(findManyNeedle);
  expect(start, `duplicate guard (${findManyNeedle}) must exist`).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("SKIPPED_DUPLICATE", start));
}

/** The exact duplicate verdict processGroup computes, over the real module. */
function isDuplicate(
  group: Frequency,
  candidate: {
    intervalWeeks: number;
    billingIntervalUnit?: string | null;
    billingIntervalCount?: number | null;
  },
): boolean {
  return frequencyToken(contractFrequency(candidate)) === frequencyToken(group);
}

describe("import duplicate guard covers the full creatable-status set", () => {
  it("the importer can create ACTIVE and PAUSED — both from one constant", () => {
    expect(importableStatuses().sort()).toEqual(["ACTIVE", "PAUSED"]);
    // The row schema derives from the SAME constant, so widening the enum
    // without widening the guard is no longer expressible.
    expect(source).toContain("z.enum(IMPORTABLE_STATUSES");
  });

  it("the candidate findMany filters on the constant, not a bare ACTIVE", () => {
    const guard = guardRegion(
      source,
      "const candidates = await prisma.subscriptionContract.findMany",
    );
    expect(guard).toContain("status: { in: [...IMPORTABLE_STATUSES] }");
    expect(guard).not.toContain('status: "ACTIVE"');
    // The skip verdict reports which status matched instead of asserting
    // "active" for a paused contract.
    expect(guard).toContain("status: true");
  });

  it("guard semantics: a PAUSED local contract IS a candidate; a CANCELLED one is NOT", () => {
    // The exact where-shape processGroup issues, statuses taken from source.
    // Cadence is deliberately NOT in the where anymore — see the token test.
    const where = {
      shopId: "shop_1",
      email: { equals: "sub@example.com", mode: "insensitive" },
      status: { in: [...importableStatuses()] },
    };
    const row = (status: string): Row => ({
      shopId: "shop_1",
      email: "sub@example.com",
      intervalWeeks: 4,
      status,
    });

    // A re-executed file must consider BOTH statuses it could have created…
    expect(matchesWhere(row("ACTIVE"), where)).toBe(true);
    expect(matchesWhere(row("PAUSED"), where)).toBe(true);
    // …while a churned subscriber stays re-importable (behavior preserved).
    expect(matchesWhere(row("CANCELLED"), where)).toBe(false);
    expect(matchesWhere(row("EXPIRED"), where)).toBe(false);
    expect(matchesWhere(row("FAILED"), where)).toBe(false);
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
      "const candidates = await prisma.subscriptionContract.findMany",
    );
    expect(guard).toContain(
      'email: { equals: group.email, mode: "insensitive" }',
    );
    expect(guard).not.toContain("email: group.email,");
  });
});

describe("cadence comparison goes through contractFrequency tokens (v1.8.0)", () => {
  it("the route guard matches tokens in JS and selects the unit+count mirror", () => {
    const guard = guardRegion(
      source,
      "const candidates = await prisma.subscriptionContract.findMany",
    );
    // Cadence must NOT be a where-filter: a pre-v1.8.0 mirror only carries
    // the week approximation, and filtering on it would either miss exact
    // mirrors or conflate distinct cadences.
    expect(guard).not.toContain("intervalWeeks: group.intervalWeeks");
    expect(guard).toContain("frequencyToken(contractFrequency(candidate))");
    // contractFrequency needs all three mirror columns to decide.
    expect(guard).toContain("intervalWeeks: true");
    expect(guard).toContain("billingIntervalUnit: true");
    expect(guard).toContain("billingIntervalCount: true");
  });

  it("a legacy week-only mirror IS a duplicate of the same WEEK cadence", () => {
    const legacyMirror = {
      intervalWeeks: 4,
      billingIntervalUnit: null,
      billingIntervalCount: null,
    };
    expect(isDuplicate({ unit: "WEEK", count: 4 }, legacyMirror)).toBe(true);
    // Same email at a DIFFERENT cadence → a different subscription, not a dupe.
    expect(isDuplicate({ unit: "WEEK", count: 2 }, legacyMirror)).toBe(false);
  });

  it("an exact unit+count mirror matches its own cadence and nothing else", () => {
    const exactMirror = {
      intervalWeeks: 2, // approxWeeks(DAY, 10)
      billingIntervalUnit: "DAY",
      billingIntervalCount: 10,
    };
    expect(isDuplicate({ unit: "DAY", count: 10 }, exactMirror)).toBe(true);
    expect(isDuplicate({ unit: "WEEK", count: 2 }, exactMirror)).toBe(false);
  });

  it("a week-approximation collision is NOT a duplicate across units", () => {
    // approxWeeks maps both "every 10 days" and "every 2 weeks" to 2 — the
    // old intervalWeeks where-filter would have called them the same
    // subscription and silently skipped a genuinely new cadence.
    const legacyTwoWeekly = {
      intervalWeeks: 2,
      billingIntervalUnit: null,
      billingIntervalCount: null,
    };
    expect(isDuplicate({ unit: "DAY", count: 10 }, legacyTwoWeekly)).toBe(false);
    // Same shape for MONTH: "every 1 month" ≠ a 4-weekly contract.
    const fourWeekly = {
      intervalWeeks: 4,
      billingIntervalUnit: "WEEK",
      billingIntervalCount: 4,
    };
    expect(isDuplicate({ unit: "MONTH", count: 1 }, fourWeekly)).toBe(false);
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

  it("processGroup's candidate findMany covers the constant, not a bare ACTIVE", () => {
    // Pre-fix this guard matched only ACTIVE, so the MIGRATION.md-prescribed
    // "fix the reported rows, re-run the file" pass re-created every PAUSED
    // group via subscriptionContractAtomicCreate: two live PAUSED Shopify
    // contracts per subscriber, both billing on resume.
    const guard = guardRegion(
      scriptSource,
      "const candidates = await ctx.prisma.subscriptionContract.findMany",
    );
    expect(guard).toContain("status: { in: [...IMPORTABLE_STATUSES] }");
    expect(guard).not.toContain('status: "ACTIVE"');
    // The skip verdict reports which status matched instead of asserting
    // "active" for a paused contract.
    expect(guard).toContain("status: true");
  });

  it("processGroup's candidate findMany matches the email case-insensitively too", () => {
    // Same double-import exposure as the route guard: the CLI pipeline
    // lowercases CSV emails while the mirror keeps Shopify's original case.
    const guard = guardRegion(
      scriptSource,
      "const candidates = await ctx.prisma.subscriptionContract.findMany",
    );
    expect(guard).toContain(
      'email: { equals: group.email, mode: "insensitive" }',
    );
    expect(guard).not.toContain("email: group.email,");
  });

  it("processGroup compares cadences through the same token match", () => {
    const guard = guardRegion(
      scriptSource,
      "const candidates = await ctx.prisma.subscriptionContract.findMany",
    );
    expect(guard).not.toContain("intervalWeeks: group.intervalWeeks");
    expect(guard).toContain("frequencyToken(contractFrequency(candidate))");
    expect(guard).toContain("intervalWeeks: true");
    expect(guard).toContain("billingIntervalUnit: true");
    expect(guard).toContain("billingIntervalCount: true");
  });
});
