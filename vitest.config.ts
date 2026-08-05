import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["tests/**/*.test.ts", "app/**/*.test.ts"],
    environment: "node",
    // Unit tests never talk to Shopify or the DB, but some modules validate
    // configuration at import time — give them harmless values.
    env: {
      DATABASE_URL: "file:./dev.sqlite",
      SHOPIFY_API_KEY: "test-api-key",
      SHOPIFY_API_SECRET: "test-api-secret",
      SHOPIFY_APP_URL: "https://cellexia-test.example.com",
      MAGIC_LINK_SECRET: "test-magic-link-secret",
      JOB_SECRET: "test-job-secret",
    },
  },
});
