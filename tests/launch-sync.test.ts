import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Launch ⇄ storefront-flag sync tests.
 *
 * The cellexia.launch_status metafield is the ONLY thing the buy box gates on
 * (cx-buybox-core.liquid: anything other than "live" renders hidden), so a
 * silent metafield failure means the admin sees "You're live" while every
 * product page stays dark — or, on revert, "back in setup" while the widget
 * is still selling. These tests pin the contract that makes that impossible:
 *
 *  - syncLaunchMetafield never throws, but always REPORTS.
 *  - goLive / revertToSetup roll the launch setting back and throw when the
 *    metafield write failed (the design-publish contract), and go-live never
 *    shifts a billing date on a launch that did not take.
 *  - launchFlagDiverged compares the flag exactly the way Liquid does.
 *
 * DB-free: every seam is mocked (klaviyo-map.test.ts / preview.test.ts
 * pattern) — an in-memory settings store stands in for prisma.
 */

interface LaunchSettingValue {
  mode: "SETUP" | "LIVE";
  wentLiveAt: string | null;
  confirmedThemeBlock: boolean;
  confirmedKlaviyo: boolean;
  previewedStorefront: boolean;
  previewedPortal: boolean;
}

const mocks = vi.hoisted(() => {
  const DEFAULT_LAUNCH = {
    mode: "SETUP" as const,
    wentLiveAt: null,
    confirmedThemeBlock: false,
    confirmedKlaviyo: false,
    previewedStorefront: false,
    previewedPortal: false,
  };
  return {
    DEFAULT_LAUNCH,
    settings: new Map<string, unknown>(),
    setSettingCalls: [] as unknown[],
    setShopMetafield: vi.fn(async (): Promise<unknown> => ({ id: "gid://mf/1" })),
    getShopMetafield: vi.fn(async (): Promise<unknown> => null),
    setNextBillingDate: vi.fn(async (): Promise<unknown> => ({})),
    contractFindMany: vi.fn(async (): Promise<unknown[]> => []),
    logEvent: vi.fn(async (): Promise<void> => {}),
  };
});

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: { findMany: mocks.contractFindMany },
    shop: { findUnique: vi.fn(async (): Promise<unknown> => null) },
  },
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({
    graphql: vi.fn(),
  })),
}));

vi.mock("~/lib/shop/install.server", () => ({
  requireShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    primaryDomain: "www.cellexia.example",
    ianaTimezone: "Europe/Zurich",
  })),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (shopId: string, key: string): Promise<unknown> => {
    return mocks.settings.get(`${shopId}:${key}`) ?? mocks.DEFAULT_LAUNCH;
  }),
  setSetting: vi.fn(
    async (
      shopId: string,
      key: string,
      value: unknown,
      _updatedBy?: string,
    ): Promise<void> => {
      mocks.settings.set(`${shopId}:${key}`, value);
      mocks.setSettingCalls.push(value);
    },
  ),
}));

vi.mock("~/lib/graphql/metafields.server", () => ({
  setShopMetafield: mocks.setShopMetafield,
  getShopMetafield: mocks.getShopMetafield,
}));

vi.mock("~/lib/contracts/service.server", () => ({
  setNextBillingDate: mocks.setNextBillingDate,
}));

vi.mock("~/lib/events/log.server", () => ({
  logEvent: mocks.logEvent,
}));

import {
  goLive,
  launchFlagDiverged,
  readLaunchMetafield,
  revertToSetup,
  syncLaunchMetafield,
} from "~/lib/launch/launch.server";

const SHOP_DOMAIN = "cellexia.myshopify.com";
const SETTING_KEY = "shop_1:launch";

function storedLaunch(): LaunchSettingValue {
  return (mocks.settings.get(SETTING_KEY) ??
    mocks.DEFAULT_LAUNCH) as LaunchSettingValue;
}

function seedLaunch(mode: "SETUP" | "LIVE"): void {
  mocks.settings.set(SETTING_KEY, {
    ...mocks.DEFAULT_LAUNCH,
    mode,
    wentLiveAt: mode === "LIVE" ? "2026-07-01T09:00:00.000Z" : null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.clear();
  mocks.setSettingCalls.length = 0;
  mocks.setShopMetafield.mockImplementation(async () => ({ id: "gid://mf/1" }));
  mocks.contractFindMany.mockImplementation(async () => []);
});

// ── syncLaunchMetafield ──────────────────────────────────────────────────────

describe("syncLaunchMetafield", () => {
  it("writes the lowercased mode and reports success", async () => {
    const result = await syncLaunchMetafield(SHOP_DOMAIN, "LIVE");
    expect(result.ok).toBe(true);
    expect(mocks.setShopMetafield).toHaveBeenCalledWith(expect.anything(), {
      namespace: "cellexia",
      key: "launch_status",
      type: "single_line_text_field",
      value: "live",
    });
  });

  it("reports failure instead of throwing (install must never break)", async () => {
    mocks.setShopMetafield.mockRejectedValueOnce(new Error("throttled"));
    const result = await syncLaunchMetafield(SHOP_DOMAIN, "SETUP");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("throttled");
  });
});

// ── goLive ───────────────────────────────────────────────────────────────────

describe("goLive", () => {
  it("flips the setting once the storefront flag is written", async () => {
    await goLive(SHOP_DOMAIN, { shiftOverdue: false, actor: "admin@x" });
    expect(storedLaunch().mode).toBe("LIVE");
    expect(mocks.setShopMetafield).toHaveBeenCalledTimes(1);
    expect(mocks.logEvent).toHaveBeenCalledTimes(1);
  });

  it("rolls the setting back and throws when the flag write fails", async () => {
    mocks.setShopMetafield.mockRejectedValueOnce(new Error("5xx from Shopify"));

    await expect(
      goLive(SHOP_DOMAIN, { shiftOverdue: false, actor: "admin@x" }),
    ).rejects.toThrow(/launch_status/);

    // The admin UI reads this back — it must not claim LIVE.
    expect(storedLaunch().mode).toBe("SETUP");
    expect(storedLaunch().wentLiveAt).toBeNull();
    // No "went live" audit event for a launch that did not happen.
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("never shifts a billing date when the flag write fails", async () => {
    mocks.contractFindMany.mockImplementation(async () => [
      {
        id: "c_1",
        shopifyContractId: "gid://shopify/SubscriptionContract/1",
        email: "a@example.com",
        firstName: null,
        lastName: null,
        nextBillingDate: new Date("2026-07-01T00:00:00Z"),
      },
    ]);
    mocks.setShopMetafield.mockRejectedValueOnce(new Error("token expired"));

    await expect(
      goLive(SHOP_DOMAIN, { shiftOverdue: true, actor: "admin@x" }),
    ).rejects.toThrow();

    expect(mocks.setNextBillingDate).not.toHaveBeenCalled();
  });
});

// ── revertToSetup ────────────────────────────────────────────────────────────

describe("revertToSetup", () => {
  it("goes dark when the storefront flag follows", async () => {
    seedLaunch("LIVE");
    await revertToSetup(SHOP_DOMAIN, "admin@x");
    expect(storedLaunch().mode).toBe("SETUP");
    expect(mocks.setShopMetafield).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ key: "launch_status", value: "setup" }),
    );
  });

  it("stays LIVE and throws when the flag write fails (no false kill switch)", async () => {
    seedLaunch("LIVE");
    mocks.setShopMetafield.mockRejectedValueOnce(new Error("network"));

    await expect(revertToSetup(SHOP_DOMAIN, "admin@x")).rejects.toThrow(
      /launch_status/,
    );

    // Storefront is still live, so the app must be too — never divergent.
    expect(storedLaunch().mode).toBe("LIVE");
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});

// ── Divergence detection (what the Preview & launch banner shows) ────────────

describe("launchFlagDiverged", () => {
  it("matches the Liquid gate: only the exact value 'live' is live", () => {
    expect(launchFlagDiverged("LIVE", "live")).toBe(false);
    expect(launchFlagDiverged("SETUP", "setup")).toBe(false);
    // Missing metafield while dark is not a divergence — Liquid fails closed.
    expect(launchFlagDiverged("SETUP", null)).toBe(false);

    // The two production failure modes.
    expect(launchFlagDiverged("LIVE", "setup")).toBe(true);
    expect(launchFlagDiverged("LIVE", null)).toBe(true);
    expect(launchFlagDiverged("SETUP", "live")).toBe(true);

    // Whitespace/case wobble from a hand-edited metafield. Liquid compares
    // with a plain `== 'live'` — no trim, no downcase — so NONE of these
    // render the widget. While the app says LIVE that is a dark store, and
    // the banner has to say so: the detector must not normalise the value
    // into agreement (it did until v1.2.3, and reported " Live " as in-sync
    // while every product page rendered the widget hidden).
    expect(launchFlagDiverged("LIVE", " Live ")).toBe(true);
    expect(launchFlagDiverged("LIVE", "Live")).toBe(true);
    expect(launchFlagDiverged("LIVE", "LIVE")).toBe(true);
    expect(launchFlagDiverged("LIVE", "live ")).toBe(true);
    expect(launchFlagDiverged("LIVE", "LIVE!")).toBe(true);
    expect(launchFlagDiverged("LIVE", "")).toBe(true);

    // Same values while the app is dark: Liquid reads them as not-live, so
    // the store IS dark and the app agrees — no divergence, no false alarm.
    expect(launchFlagDiverged("SETUP", " Live ")).toBe(false);
    expect(launchFlagDiverged("SETUP", "LIVE")).toBe(false);
    expect(launchFlagDiverged("SETUP", "")).toBe(false);
  });

  it("agrees with the value syncLaunchMetafield actually writes", () => {
    // The detector is only useful if the app's own write is the one value it
    // calls in-sync — an exact comparison makes that pairing load-bearing.
    for (const mode of ["LIVE", "SETUP"] as const) {
      expect(launchFlagDiverged(mode, mode.toLowerCase())).toBe(false);
    }
  });
});

describe("readLaunchMetafield", () => {
  it("returns the raw value, or null when the metafield does not exist", async () => {
    const admin = { graphql: vi.fn() };
    expect(await readLaunchMetafield(admin)).toBeNull();

    mocks.getShopMetafield.mockResolvedValueOnce({
      id: "gid://mf/1",
      namespace: "cellexia",
      key: "launch_status",
      type: "single_line_text_field",
      value: "live",
    });
    expect(await readLaunchMetafield(admin)).toBe("live");
  });
});
