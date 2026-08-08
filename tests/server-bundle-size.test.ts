import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * SIZE GUARD for the app's SERVER BUNDLE — tracked growth, not a platform
 * limit.
 *
 * The extension's .liquid/JS/CSS budgets (tests/liquid/size-limits.test.ts)
 * exist because Shopify hard-rejects oversized deploys. The app server has
 * no such platform limit — which is exactly why its bundle grew to ~2.3MB
 * without anyone noticing (v1.6.7 review finding: "only the extension has a
 * size gate; the app build has none"). This guard makes that growth visible:
 * a generous ceiling that today's build clears with ~40% headroom, so it
 * only trips on a step change (an accidentally bundled dependency, a vendored
 * asset, a data file swept into the build) — never on ordinary feature work.
 *
 * STALENESS MODEL: vitest cannot build the app, so this measures the LAST
 * `npm run build` output. `npm run verify` runs tests before build, so a
 * regression introduced in the same session is caught on the NEXT verify (or
 * any test run after a build). When `build/` does not exist at all (fresh
 * checkout, CI without a build step) the suite skips rather than inventing
 * a failure — the guard is advisory tracking, not a deploy blocker.
 *
 * Remediation when it trips: `npx vite-bundle-visualizer` (or inspect the
 * import added by the offending commit) to find what got pulled into the
 * server graph; server-only data belongs in the DB or on disk at runtime,
 * not inlined into the bundle.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER_BUILD_DIR = join(REPO_ROOT, "build", "server");

const KB = 1024;

/** Ceiling for the single biggest server chunk (today: ~2.16MB). */
const SERVER_CHUNK_LIMIT = 3 * KB * KB;

/** Ceiling for the whole build/server tree (today: ~2.3MB). */
const SERVER_TOTAL_LIMIT = 4 * KB * KB;

function reportBytes(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} bytes`;
}

/** Every file under a directory, at any depth. */
function everyFile(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...everyFile(full));
    else found.push(full);
  }
  return found.sort();
}

describe.skipIf(!existsSync(SERVER_BUILD_DIR))(
  "server bundle size (tracked growth — measures the last npm run build)",
  () => {
    const files = everyFile(SERVER_BUILD_DIR).map((file) => ({
      file: file.slice(REPO_ROOT.length),
      size: statSync(file).size,
    }));

    it("has build output to measure (non-vacuity)", () => {
      expect(files.length).toBeGreaterThan(0);
      expect(files.some((entry) => entry.file.endsWith(".js"))).toBe(true);
    });

    it("keeps the biggest server chunk under 3MB", () => {
      const biggest = [...files].sort((a, b) => b.size - a.size)[0];
      expect(
        biggest.size,
        `${biggest.file} is ${reportBytes(biggest.size)}, over the ` +
          `${reportBytes(SERVER_CHUNK_LIMIT)} chunk ceiling. This is a ` +
          `tracked-growth guard, not a platform limit: something stepped ` +
          `the server bundle up — find the newly bundled dependency or ` +
          `inlined data and move it out of the server graph.`,
      ).toBeLessThanOrEqual(SERVER_CHUNK_LIMIT);
    });

    it("keeps the whole build/server tree under 4MB", () => {
      const total = files.reduce((sum, entry) => sum + entry.size, 0);
      const largest = [...files]
        .sort((a, b) => b.size - a.size)
        .slice(0, 5)
        .map((entry) => `  ${reportBytes(entry.size).padStart(13)}  ${entry.file}`)
        .join("\n");
      expect(
        total,
        `build/server totals ${reportBytes(total)}, over the ` +
          `${reportBytes(SERVER_TOTAL_LIMIT)} ceiling. Five largest:\n` +
          `${largest}\nThis is a tracked-growth guard, not a platform ` +
          `limit — raise it deliberately in a reviewed change if the app ` +
          `genuinely needs the room.`,
      ).toBeLessThanOrEqual(SERVER_TOTAL_LIMIT);
    });
  },
);
