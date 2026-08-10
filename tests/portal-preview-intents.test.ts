import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Admin "Preview the portal" intents (v1.7.0): preview-portal-demo and
 * preview-portal-subscriber return DIRECT store-domain URLs carrying the
 * signed ?cx_pp= token — no magic-link LOGIN hop, no hand-off cookie. The
 * old flow minted a LOGIN link whose exchange set a Set-Cookie the app proxy
 * strips on a live store, dead-ending every preview at the setup gate.
 */

process.env.APP_SIGNING_SECRET = "test-secret-for-preview-intents";

const mocks = vi.hoisted(() => {
  const shop = {
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    primaryDomain: "cellexialabs.com",
  };
  const demoContract = {
    id: "ctr_demo",
    shopId: "shop_1",
    customerId: "gid://shopify/Customer/999",
    email: "demo@example.com",
    isDemo: true,
  };
  return {
    shop,
    demoContract,
    contractFindFirst: vi.fn(async (): Promise<unknown> => demoContract),
    contractFindUniqueOrThrow: vi.fn(async (): Promise<unknown> => demoContract),
    logEvent: vi.fn(async (_input?: unknown): Promise<void> => {}),
    getLaunchState: vi.fn(async (): Promise<unknown> => ({
      mode: "SETUP",
      previewedPortal: false,
      previewedStorefront: false,
      confirmedThemeBlock: false,
      confirmedKlaviyo: false,
    })),
    markChecklist: vi.fn(async (): Promise<void> => {}),
    createDemoContract: vi.fn(async (): Promise<unknown> => ({
      contractId: "ctr_demo",
    })),
  };
});

vi.mock("~/db.server", () => ({
  default: {
    // buildPortalUrl reads the shop row for its store domain.
    shop: { findUnique: vi.fn(async (): Promise<unknown> => mocks.shop) },
    subscriptionContract: {
      findFirst: mocks.contractFindFirst,
      findUniqueOrThrow: mocks.contractFindUniqueOrThrow,
    },
  },
}));

vi.mock("~/shopify.server", () => ({
  authenticate: {
    admin: vi.fn(async () => ({
      admin: {},
      session: { shop: "cellexia.myshopify.com" },
    })),
  },
  adminClientForShop: vi.fn(),
}));

vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => mocks.shop),
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

vi.mock("~/lib/launch/launch.server", () => ({
  buildStorefrontPreviewUrl: vi.fn(),
  getLaunchState: mocks.getLaunchState,
  getOverdueContracts: vi.fn(async (): Promise<unknown[]> => []),
  goLive: vi.fn(),
  launchFlagDiverged: vi.fn(() => false),
  markChecklist: mocks.markChecklist,
  probeProxyIdentity: vi.fn(async (): Promise<unknown> => null),
  readLaunchMetafield: vi.fn(async (): Promise<unknown> => null),
  revertToSetup: vi.fn(),
  syncLaunchMetafield: vi.fn(),
}));

vi.mock("~/lib/launch/doctor.server", () => ({
  runPreviewDoctor: vi.fn(),
}));

vi.mock("~/lib/portal/demo.server", () => ({
  createDemoContract: mocks.createDemoContract,
}));

vi.mock("~/lib/klaviyo/client.server", () => ({
  isKlaviyoConfigured: vi.fn(() => false),
}));

vi.mock("~/lib/graphql/index.server", () => ({
  getProducts: vi.fn(async (): Promise<unknown[]> => []),
  getSubscribableProducts: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("~/lib/ownership/ownership.server", () => ({
  OURS_ONLY: {},
  getOwnershipCounts: vi.fn(),
  reclassifyContracts: vi.fn(),
}));

vi.mock("~/lib/ownership/foreign-groups.server", () => ({
  scanForeignSellingPlanGroups: vi.fn(),
  toForeignGroupScanJson: vi.fn(),
}));

import { action } from "~/routes/app.preview";
import { verifyPreviewToken } from "~/lib/portal/previewToken.server";
import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";

async function runIntent(fields: Record<string, string>): Promise<{
  ok: boolean;
  url?: string;
  toast?: string;
}> {
  const form = new URLSearchParams(fields);
  const response = (await action({
    request: new Request("https://app.example/app/preview", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    params: {},
    context: {},
  } as never)) as Response;
  return (await response.json()) as { ok: boolean; url?: string; toast?: string };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.contractFindFirst.mockResolvedValue(mocks.demoContract);
});

describe("preview-portal-demo", () => {
  it("returns a direct store-domain portal URL with a verifiable cx_pp token", async () => {
    const data = await runIntent({ intent: "preview-portal-demo" });
    expect(data.ok).toBe(true);
    expect(data.url).toBeDefined();

    const url = new URL(data.url as string);
    // Store domain + proxy base — opens instantly, no app-host magic hop.
    expect(url.origin).toBe("https://cellexialabs.com");
    expect(url.pathname).toBe(`${PORTAL_PROXY_BASE}/`);
    expect(url.searchParams.get("handoff")).toBeNull();
    expect(url.pathname).not.toContain("/magic/");

    const token = url.searchParams.get("cx_pp");
    expect(token).toBeTruthy();
    const payload = verifyPreviewToken(token as string, "shop_1");
    expect(payload).not.toBeNull();
    expect(payload?.customerId).toBe("gid://shopify/Customer/999");
    expect(payload?.contractId).toBe("ctr_demo");
    expect(payload?.email).toBe("demo@example.com");

    // Checklist + audit trail preserved.
    expect(mocks.markChecklist).toHaveBeenCalledWith(
      "shop_1",
      "previewedPortal",
      true,
      expect.any(String),
    );
    const event = mocks.logEvent.mock.calls[0]?.[0] as {
      payload: Record<string, unknown>;
    };
    expect(event.payload.action).toBe("portal_preview_created");
    expect(event.payload.mode).toBe("demo");
    expect(event.payload.via).toBe("cx_pp");
  });
});

describe("preview-portal-subscriber", () => {
  it("returns a direct cx_pp URL for the subscriber's newest contract", async () => {
    mocks.contractFindFirst.mockResolvedValue({
      id: "ctr_real",
      shopId: "shop_1",
      customerId: "gid://shopify/Customer/42",
      email: "sub@example.com",
      isDemo: false,
    });
    const data = await runIntent({
      intent: "preview-portal-subscriber",
      email: "sub@example.com",
    });
    expect(data.ok).toBe(true);
    const url = new URL(data.url as string);
    expect(url.pathname).toBe(`${PORTAL_PROXY_BASE}/`);
    const payload = verifyPreviewToken(
      url.searchParams.get("cx_pp") as string,
      "shop_1",
    );
    expect(payload?.customerId).toBe("gid://shopify/Customer/42");
    expect(payload?.contractId).toBe("ctr_real");
  });

  it("still refuses an email with no owned contract", async () => {
    mocks.contractFindFirst.mockResolvedValue(null);
    const data = await runIntent({
      intent: "preview-portal-subscriber",
      email: "stranger@example.com",
    });
    expect(data.ok).toBe(false);
    expect(data.url).toBeUndefined();
  });
});
