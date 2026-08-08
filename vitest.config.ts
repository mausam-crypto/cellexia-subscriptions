import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Vitest config for the pure-logic test suite (tests/**).
 *
 * - node environment, no DB / network: DB-touching seams are vi.mock'ed
 *   per-test (see tests/tokens.test.ts, tests/klaviyo-map.test.ts).
 * - "~" resolves to ./app exactly like tsconfig.json / vite.config.ts.
 * - TZ is pinned to UTC so timezone math tests (Europe/London DST and
 *   friends) are deterministic regardless of the host machine's clock.
 * - onConsoleLog suppresses stderr matching the app's own error-logging
 *   convention — console.error("[subsystem] ...") with a lowercase bracketed
 *   prefix ([webhooks], [ownership], [dunning], ...). Error-path tests
 *   trigger those logs ON PURPOSE (throttled metafield writes,
 *   foreign-contract skips, handler kabooms), and their stack traces would
 *   otherwise bury a real failure trace in CI output. Anything NOT matching
 *   the convention (unexpected errors, unhandled rejections) still prints,
 *   and vitest reports test failures through its reporter regardless of
 *   this hook. Tests that ASSERT on these logs use vi.spyOn(console, ...),
 *   which this output filter does not affect.
 */

/** The app's stderr logging convention: "[subsystem] message". */
const APP_LOG_PREFIX = /^\[[a-z][a-z-]*\] /;

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      TZ: "UTC",
    },
    onConsoleLog(log, type) {
      if (type === "stderr" && APP_LOG_PREFIX.test(log)) {
        return false;
      }
    },
  },
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
});
