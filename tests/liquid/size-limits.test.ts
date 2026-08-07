import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ASSETS_DIR,
  BLOCKS_DIR,
  EXTENSION_DIR,
  LOCALES_DIR,
  REPO_ROOT,
  extensionLiquidFiles,
} from "./harness";

/**
 * SIZE GUARDS for the theme app extension — the fourth deploy blocker class.
 *
 * THE LIMIT MODEL (corrected in v1.6.4): verified by real shopify app deploy:
 * the 100KB Liquid budget is TOTAL across the extension, not per-file. The
 * merchant's developer ran an actual `shopify app deploy` and watched it
 * reject an extension whose every individual file was under 100KB but whose
 * .liquid files SUMMED past 102,400 bytes. v1.6.3's guard modeled the limit
 * as per-file — wrong — so a tree that passed CI still failed on the deploy
 * console. A corollary: splitting Liquid across more files buys NOTHING under
 * a total budget; only actual byte reduction does (the preset partials are
 * kept for maintainability, not for budget).
 *
 * PRIMARY GUARD: the TOTAL of every shipped .liquid file ≤ 90,112 bytes
 * (88KB — 12% margin under the platform's 102,400-byte total budget, so
 * growth is caught while there is still room to land a hotfix without a
 * refactor; this matches the working ceiling documented in
 * extensions/cellexia-buy-box/README.md). BELT: no single file may exceed
 * the same 90,112 bytes either — trivially implied by the total today, but
 * it survives any future change to the total constant.
 *
 * The other ceilings, unchanged from v1.6.3, with failure messages saying
 * which kind each is:
 *
 *   PLATFORM LIMITS, held at ~90% headroom:
 *     - blocks/            ≤ 25 files (the platform's per-extension block cap)
 *     - the whole extension ≤ 9MB (our ceiling; the platform rejects at 10MB)
 *     - each locales/*.json parses AND ≤ 16KB (the platform's locale-file cap)
 *
 *   OUR OWN PERFORMANCE CEILINGS (no platform limit backs them — they exist so
 *   the PDP payload cannot quietly bloat):
 *     - each assets/*.js  ≤ 94,208 bytes (92KB)
 *     - each assets/*.css ≤ 65,536 bytes (64KB)
 *
 * Remediation for the Liquid budget, in strict order of preference:
 *   (1) strip whitespace and comment prose FIRST — leading indentation and
 *       blank lines are semantics-preserving to remove (keep every newline;
 *       several are load-bearing), and prose belongs in
 *       extensions/cellexia-buy-box/README.md "Core snippet internals", not
 *       in shipped bytes;
 *   (2) merge preset partials back into the core's {% case %} SECOND — under
 *       a total budget a partial costs its render call plus a file header and
 *       buys no budget back (NEVER a captured render — see
 *       tests/liquid/lint.test.ts for why that corrupted v1.2.0);
 *   (3) move display logic into assets/ JS/CSS LAST — assets do not count
 *       against the Liquid budget, but this changes the hydration contract,
 *       so it is the most expensive option.
 */

const KB = 1024;

/**
 * PRIMARY: our ceiling on the TOTAL bytes of all shipped .liquid files: 88KB
 * (the working ceiling documented in extensions/cellexia-buy-box/README.md).
 * Shopify's hard reject is at 102,400 bytes TOTAL across the extension
 * (empirically verified by the merchant's developer via a real
 * `shopify app deploy` — NOT per-file, as v1.6.3 wrongly assumed).
 */
const LIQUID_TOTAL_LIMIT = 90_112;

/**
 * BELT: no single .liquid file may exceed the total ceiling either. Implied
 * by the total today; kept so the invariant survives constant changes.
 */
const LIQUID_FILE_LIMIT = 90_112;

/** Shopify's cap on blocks per theme app extension. */
const BLOCK_COUNT_LIMIT = 25;

/** Our whole-extension ceiling: 9MB. Shopify rejects the bundle at 10MB. */
const BUNDLE_LIMIT = 9 * KB * KB;

/** Shopify's cap per locale file. */
const LOCALE_FILE_LIMIT = 16 * KB;

/** OUR performance ceiling per storefront script (no platform limit). */
const JS_FILE_LIMIT = 92 * KB;

/** OUR performance ceiling per stylesheet (no platform limit). */
const CSS_FILE_LIMIT = 64 * KB;

function repoPath(file: string): string {
  return relative(REPO_ROOT, file);
}

function sizeOf(file: string): number {
  return statSync(file).size;
}

function reportBytes(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} bytes`;
}

/** Every file in the extension directory, at any depth. */
function everyExtensionFile(directory: string = EXTENSION_DIR): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...everyExtensionFile(full));
    else found.push(full);
  }
  return found.sort();
}

const liquidFiles = extensionLiquidFiles();

describe("total Liquid size (the deploy blocker, corrected model)", () => {
  it("has .liquid files to measure (non-vacuity)", () => {
    expect(liquidFiles.length).toBeGreaterThan(0);
  });

  it("keeps the TOTAL shipped Liquid under the 88KB ceiling (PRIMARY)", () => {
    const sizes = liquidFiles.map((file) => ({
      file: repoPath(file),
      size: sizeOf(file),
    }));
    const total = sizes.reduce((sum, entry) => sum + entry.size, 0);
    const table = sizes
      .sort((a, b) => b.size - a.size)
      .map((entry) => `  ${reportBytes(entry.size).padStart(13)}  ${entry.file}`)
      .join("\n");
    expect(
      total,
      `the extension ships ${reportBytes(total)} of Liquid, over our ` +
        `${reportBytes(LIQUID_TOTAL_LIMIT)} TOTAL ceiling. Verified by real ` +
        `shopify app deploy: the 100KB Liquid budget is TOTAL across the ` +
        `extension, not per-file — Shopify hard-rejects the deploy when all ` +
        `.liquid files SUM past 102,400 bytes, so splitting files buys ` +
        `nothing. Largest first:\n${table}\n` +
        `Remediation, in order: (1) strip leading whitespace, blank lines ` +
        `and comment prose first (keep every newline; prose moves to ` +
        `extensions/cellexia-buy-box/README.md "Core snippet internals"); ` +
        `(2) merge a preset partial back into the core's {% case %} second ` +
        `(a partial costs its render call + header and buys no budget back; ` +
        `NEVER a captured render — see tests/liquid/lint.test.ts); (3) move ` +
        `display logic into assets/ JS/CSS last (assets do not count ` +
        `against the Liquid budget).`,
    ).toBeLessThanOrEqual(LIQUID_TOTAL_LIMIT);
  });

  it.each(liquidFiles.map(repoPath))(
    "%s stays under the 88KB per-file belt",
    (relativeFile) => {
      const size = sizeOf(join(REPO_ROOT, relativeFile));
      expect(
        size,
        `${relativeFile} is ${reportBytes(size)}, over our ` +
          `${reportBytes(LIQUID_FILE_LIMIT)} per-file belt. This belt is ` +
          `implied by the TOTAL guard above (verified by real shopify app ` +
          `deploy: the 100KB Liquid budget is TOTAL across the extension, ` +
          `not per-file) — if this fails, the total guard has failed too; ` +
          `fix the total first: strip whitespace/comment prose, then merge ` +
          `partials, then move logic to assets/.`,
      ).toBeLessThanOrEqual(LIQUID_FILE_LIMIT);
    },
  );
});

describe("block count", () => {
  it(`ships at most ${BLOCK_COUNT_LIMIT} blocks (the platform's cap)`, () => {
    const blocks = readdirSync(BLOCKS_DIR).filter((name) =>
      name.endsWith(".liquid"),
    );
    expect(blocks.length, "block files found (non-vacuity)").toBeGreaterThan(0);
    expect(
      blocks.length,
      `extensions/cellexia-buy-box/blocks holds ${blocks.length} blocks, ` +
        `over the platform's limit of ${BLOCK_COUNT_LIMIT} per theme app ` +
        `extension: ${blocks.join(", ")}. Remediation: merge blocks or move ` +
        `variants behind schema settings on an existing block.`,
    ).toBeLessThanOrEqual(BLOCK_COUNT_LIMIT);
  });
});

describe("whole-extension bundle size", () => {
  it("stays under the 9MB ceiling", () => {
    const files = everyExtensionFile();
    expect(files.length, "extension files found (non-vacuity)").toBeGreaterThan(
      25,
    );
    const sizes = files.map((file) => ({
      file: repoPath(file),
      size: sizeOf(file),
    }));
    const total = sizes.reduce((sum, entry) => sum + entry.size, 0);
    const largest = sizes
      .sort((a, b) => b.size - a.size)
      .slice(0, 10)
      .map((entry) => `  ${reportBytes(entry.size).padStart(13)}  ${entry.file}`)
      .join("\n");
    expect(
      total,
      `the extension bundle is ${reportBytes(total)}, over our ` +
        `${reportBytes(BUNDLE_LIMIT)} ceiling (the platform rejects the ` +
        `deploy at 10MB). Ten largest files:\n${largest}\n` +
        `Remediation: serve large images from the shop's own Files CDN ` +
        `instead of assets/, and strip anything blocks/snippets never ` +
        `reference.`,
    ).toBeLessThanOrEqual(BUNDLE_LIMIT);
  });
});

describe("locale files", () => {
  const locales = readdirSync(LOCALES_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();

  it("has locale files to check (non-vacuity)", () => {
    expect(locales.length).toBeGreaterThan(20);
    expect(locales).toContain("en.default.json");
  });

  it.each(locales)("locales/%s parses as JSON", (name) => {
    const file = join(LOCALES_DIR, name);
    expect(
      () => JSON.parse(readFileSync(file, "utf8")),
      `${repoPath(file)} is not valid JSON — the platform rejects the deploy ` +
        `and the storefront would fall back to raw translation keys. ` +
        `Remediation: fix the syntax error (a locale file is strict JSON: ` +
        `no comments, no trailing commas).`,
    ).not.toThrow();
  });

  it.each(locales)("locales/%s stays under the 16KB cap", (name) => {
    const file = join(LOCALES_DIR, name);
    const size = sizeOf(file);
    expect(
      size,
      `${repoPath(file)} is ${reportBytes(size)}, over the platform's ` +
        `${reportBytes(LOCALE_FILE_LIMIT)} per-locale-file cap. ` +
        `Remediation: shorten the longest strings or drop keys the Liquid ` +
        `no longer reads (tests/liquid/render.test.ts pins the ones it does).`,
    ).toBeLessThanOrEqual(LOCALE_FILE_LIMIT);
  });
});

describe("asset budgets (our own performance ceilings)", () => {
  const scripts = readdirSync(ASSETS_DIR).filter((name) => name.endsWith(".js"));
  const stylesheets = readdirSync(ASSETS_DIR).filter((name) =>
    name.endsWith(".css"),
  );

  it("has JS and CSS assets to check (non-vacuity)", () => {
    expect(scripts.length).toBeGreaterThan(0);
    expect(stylesheets.length).toBeGreaterThan(0);
  });

  it.each(scripts)("assets/%s stays under the 92KB script budget", (name) => {
    const file = join(ASSETS_DIR, name);
    const size = sizeOf(file);
    expect(
      size,
      `${repoPath(file)} is ${reportBytes(size)}, over our ` +
        `${reportBytes(JS_FILE_LIMIT)} per-script budget. This is OUR ` +
        `performance ceiling, not a platform limit: the file ships to every ` +
        `PDP view, so it may not quietly bloat. Remediation: delete dead ` +
        `branches, or split a rarely-taken path into its own lazily-added ` +
        `asset (and add it to the guards in tests/liquid/lint.test.ts).`,
    ).toBeLessThanOrEqual(JS_FILE_LIMIT);
  });

  it.each(stylesheets)(
    "assets/%s stays under the 64KB stylesheet budget",
    (name) => {
      const file = join(ASSETS_DIR, name);
      const size = sizeOf(file);
      expect(
        size,
        `${repoPath(file)} is ${reportBytes(size)}, over our ` +
          `${reportBytes(CSS_FILE_LIMIT)} per-stylesheet budget. This is OUR ` +
          `performance ceiling, not a platform limit: the file ships to ` +
          `every PDP view, so it may not quietly bloat. Remediation: ` +
          `collapse per-preset duplication into shared rules, or drop ` +
          `styles no shipped preset reaches.`,
      ).toBeLessThanOrEqual(CSS_FILE_LIMIT);
    },
  );
});
