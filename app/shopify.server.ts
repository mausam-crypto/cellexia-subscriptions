import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { logger } from "./lib/logger.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  // Custom app for the merchant's own store by default; set
  // SHOPIFY_APP_DISTRIBUTION=app_store before a public App Store listing.
  distribution:
    process.env.SHOPIFY_APP_DISTRIBUTION === "app_store"
      ? AppDistribution.AppStore
      : AppDistribution.SingleMerchant,
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    removeRest: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

/**
 * DEMO MODE (local preview only — see docs/DEMO-MODE.md).
 *
 * When DEMO_MODE=1, `authenticate.admin` is replaced with a stub that skips
 * Shopify OAuth entirely and hands every admin route a fake session for
 * DEMO_SHOP. Every other authenticate member (webhook, public, flow, …)
 * stays the real implementation. The fake context's `admin.graphql` throws,
 * so read-only views over seeded local data work while anything that would
 * hit the Shopify Admin API fails loudly.
 */
/**
 * Demo mode is only honored on a localhost app URL — a production host that
 * accidentally inherits DEMO_MODE=1 from a copied .env must NOT silently run
 * with admin auth bypassed. DEMO_MODE_DANGEROUS_OK=1 exists solely for
 * non-localhost demo rigs that consciously accept the risk.
 */
const demoRequested = process.env.DEMO_MODE === "1";
const demoHostAllowed =
  /localhost|127\.0\.0\.1/.test(process.env.SHOPIFY_APP_URL ?? "") ||
  process.env.DEMO_MODE_DANGEROUS_OK === "1";
const DEMO_MODE = demoRequested && demoHostAllowed;
/** Must match the shop seeded by scripts/seed-demo.mjs. */
const DEMO_SHOP = process.env.DEMO_SHOP || "cellexia-demo.myshopify.com";

if (DEMO_MODE) {
  logger.warn(
    "DEMO_MODE=1 — admin auth is BYPASSED; never set this in production",
    { demoShop: DEMO_SHOP },
  );
} else if (demoRequested) {
  logger.error(
    "DEMO_MODE=1 REFUSED: SHOPIFY_APP_URL is not localhost. Remove DEMO_MODE from this environment (or set DEMO_MODE_DANGEROUS_OK=1 on a deliberate demo rig). Running with REAL auth.",
    { appUrl: process.env.SHOPIFY_APP_URL ?? null },
  );
}

function buildDemoAdminContext() {
  return {
    session: {
      id: "demo",
      shop: DEMO_SHOP,
      state: "",
      isOnline: true,
      email: "demo-admin@cellexia.test",
      onlineAccessInfo: {
        associated_user: { email: "demo-admin@cellexia.test" },
      },
    },
    admin: {
      graphql: async () => {
        throw new Error(
          "Demo mode: Shopify Admin API calls are disabled — connect a real store with 'shopify app config link' to enable actions.",
        );
      },
    },
  };
}

const demoAuthenticate = {
  ...shopify.authenticate,
  admin: async (_request: Request) => buildDemoAdminContext(),
} as unknown as typeof shopify.authenticate;

// Offline contexts (jobs, portal loaders) get the same demo stub so they fail
// with the clear demo-mode message instead of SessionNotFoundError.
const demoUnauthenticated = {
  ...shopify.unauthenticated,
  admin: async (_shop: string) => buildDemoAdminContext(),
} as unknown as typeof shopify.unauthenticated;

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = DEMO_MODE ? demoAuthenticate : shopify.authenticate;
export const unauthenticated = DEMO_MODE
  ? demoUnauthenticated
  : shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
