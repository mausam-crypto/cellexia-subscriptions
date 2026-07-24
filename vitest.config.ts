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
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      TZ: "UTC",
    },
  },
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
});
