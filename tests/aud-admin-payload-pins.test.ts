import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static pins for admin-route audit payloads (C5 / app.plans history) and the
 * dashboard loaders' forecast-grade hand-off.
 *
 * These payloads are the operator's only record once a run scrolls out of the
 * server logs — a silently dropped key is invisible until the day someone
 * needs it. The route actions are Remix-loader-shaped (heavy to invoke in a
 * unit test), so these are TEXT-LEVEL pins in the house style of
 * tests/ownership-enforcement.test.ts: comments stripped, the exact
 * load-bearing expressions asserted inside the relevant payload block.
 *
 * Pinned:
 *  - C5: app.bulk.tsx plan_migration AND mass_skip admin.action payloads
 *    carry failedContracts [{ contractId, error }] (bounded by BULK_LIMIT) —
 *    a count plus first-error cannot answer "which contracts, and why".
 *  - app.plans.tsx product_cogs_override_updated / product_cadence_updated
 *    payloads carry { previous, next } — cost-model/forecast parameter edits
 *    must be datable and reversible from the event stream alone.
 *  - Both dashboards pass their own forecast run's accuracy grade into
 *    getInsights (without it every page load computes a second full
 *    forecast).
 *  - app.analytics.tsx counts EXTERNAL into voluntary churn (CM-3 read side
 *    — behaviorally pinned for the rollup in
 *    tests/aud-analytics-rollup-integrity.test.ts).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

/** Blank out comments so a pin can never be satisfied by prose. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * The source slice from an `action: "<name>"` payload key to the block's
 * closing `})` — generous but bounded, so an assertion about one payload
 * cannot be satisfied by a key that only exists in the OTHER action's block.
 */
function payloadBlock(source: string, action: string): string {
  const start = source.indexOf(`action: "${action}"`);
  expect(start, `payload block for ${action} not found`).toBeGreaterThan(-1);
  return source.slice(start, start + 1200);
}

describe("C5 — bulk-run payloads name every failed contract", () => {
  const source = stripComments(read("app/routes/app.bulk.tsx"));

  it("collects per-contract failures as { contractId, error }", () => {
    const collectors = source.match(
      /const failed: Array<\{ contractId: string; error: string \}> = \[\];/g,
    );
    expect(collectors).toHaveLength(2); // plan migration + mass skip
  });

  it.each(["plan_migration", "mass_skip"])(
    "the %s admin.action payload carries failedContracts",
    (action) => {
      const block = payloadBlock(source, action);
      expect(block).toContain(
        "...(failed.length > 0 ? { failedContracts: failed } : {})",
      );
      // The bound that keeps the payload row-sized stays alongside.
      expect(block).toContain("batchLimit: BULK_LIMIT");
    },
  );
});

describe("app.plans history — parameter edits record where the value moved FROM", () => {
  const source = stripComments(read("app/routes/app.plans.tsx"));

  it("product_cogs_override_updated carries { previous, next } for the override", () => {
    const block = payloadBlock(source, "product_cogs_override_updated");
    expect(block).toContain("previous: existing?.unitCostCentsOverride ?? null");
    expect(block).toContain("next: unitCostCentsOverride");
  });

  it("product_cadence_updated carries { previous, next } for estDaysToEmpty", () => {
    const block = payloadBlock(source, "product_cadence_updated");
    expect(block).toContain("previous: existing?.estDaysToEmpty ?? null");
    expect(block).toContain("next: estDaysToEmpty");
  });
});

describe("dashboard loaders reuse their own forecast run for insights", () => {
  it.each(["app/routes/app._index.tsx", "app/routes/app.analytics.tsx"])(
    "%s passes forecast.accuracy.grade into getInsights",
    (file) => {
      const source = stripComments(read(file));
      expect(source).toContain(
        "getInsights(shop.id, now, { forecastGrade: f.accuracy.grade })",
      );
      // The failure leg passes the known-unknown, never re-computes.
      expect(source).toContain(
        "getInsights(shop.id, now, { forecastGrade: null })",
      );
      // No remaining grade-less call that would trigger the self-computing
      // default (a second full forecast per page load).
      expect(source).not.toContain("getInsights(shop.id, now)");
    },
  );
});

describe("analytics-page churn split (CM-3 read side)", () => {
  it("counts EXTERNAL into voluntary churn, next to CUSTOMER/ADMIN", () => {
    const source = stripComments(read("app/routes/app.analytics.tsx"));
    const split = source.slice(source.indexOf("let voluntaryChurn"));
    expect(split).toContain('group.cancelSource === "EXTERNAL"');
  });
});
