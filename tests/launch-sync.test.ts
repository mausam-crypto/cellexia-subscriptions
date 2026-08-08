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
 *    metafield write failed (the design-publish contract).
 *  - goLive staggers overdue renewals BEFORE the mode flips: the billing
 *    sweep gates on the launch setting and ticks on its own schedule, so a
 *    LIVE flip ahead of a minutes-long stagger loop hands the next sweep
 *    every not-yet-shifted overdue contract in one same-day burst.
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
    contractFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
    logEvent: vi.fn(async (_input?: unknown): Promise<void> => {}),
    publishOwnGroupsMetafield: vi.fn(async (): Promise<unknown> => ({ ok: true })),
    reclassifyAllContracts: vi.fn(async (): Promise<unknown> => ({
      scanned: 0,
      changed: 0,
      resynced: 0,
      errors: 0,
      remaining: 0,
      counts: { ours: 0, foreign: 0, unknown: 0 },
    })),
    /** The single bounded pass. Go-live must NOT be the thing that calls it. */
    reclassifyContracts: vi.fn(async (): Promise<unknown> => ({
      scanned: 0,
      changed: 0,
      resynced: 0,
      errors: 0,
      remaining: 0,
      counts: { ours: 0, foreign: 0, unknown: 0 },
    })),
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

vi.mock("~/lib/ownership/ownership.server", () => ({
  OURS_ONLY: { ownership: "OURS" },
  publishOwnGroupsMetafield: mocks.publishOwnGroupsMetafield,
  reclassifyAllContracts: mocks.reclassifyAllContracts,
  reclassifyContracts: mocks.reclassifyContracts,
}));

import {
  getOverdueContracts,
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
  mocks.setNextBillingDate.mockImplementation(async () => ({}));
  mocks.contractFindMany.mockImplementation(async () => []);
  mocks.publishOwnGroupsMetafield.mockImplementation(async () => ({ ok: true }));
  mocks.reclassifyAllContracts.mockImplementation(async () => ({
    scanned: 0,
    changed: 0,
    resynced: 0,
    errors: 0,
    remaining: 0,
    counts: { ours: 0, foreign: 0, unknown: 0 },
  }));
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

  describe("the go-live audit records what the allow-list actually unlocks", () => {
    /**
     * `ok: true` from publishOwnGroupsMetafield() is NOT "the buy box works".
     * The storefront requires a group to be named in `groupIds` AND to contain
     * one of `planIds` before it renders anything, so an allow-list carrying
     * group ids but no plan ids renders NOTHING on every product. Recording
     * that as a bare "published" is how a shop goes live with a dark buy box
     * and no trace of it in the audit trail.
     */
    function auditedPlanGroups(): string {
      const call = mocks.logEvent.mock.calls.at(-1)?.[0] as
        | { payload?: { planGroupsMetafield?: string } }
        | undefined;
      return call?.payload?.planGroupsMetafield ?? "";
    }

    it("reports counts when every factor is populated and healed", async () => {
      mocks.publishOwnGroupsMetafield.mockImplementation(async () => ({
        ok: true,
        value: {
          v: 2,
          groupIds: ["77"],
          planIds: ["1", "2"],
          planSets: [["1", "2"]],
          appId: "4477001",
        },
        heal: { stamped: [], alreadyStamped: ["gid"], failed: [] },
      }));

      await goLive(SHOP_DOMAIN, { shiftOverdue: false, actor: "admin@x" });

      expect(auditedPlanGroups()).toBe(
        "published (1 group id(s), 2 plan id(s), 1 plan set(s), appId stamped)",
      );
    });

    it("flags a publish whose planSets came out empty as incomplete (v1.6.9)", async () => {
      mocks.publishOwnGroupsMetafield.mockImplementation(async () => ({
        ok: true,
        value: {
          v: 2,
          groupIds: ["77"],
          planIds: ["1", "2"],
          planSets: [],
          appId: "4477001",
        },
        heal: { stamped: [], alreadyStamped: [], failed: [] },
      }));

      await goLive(SHOP_DOMAIN, { shiftOverdue: false, actor: "admin@x" });

      const audited = auditedPlanGroups();
      expect(audited).toContain("INCOMPLETE");
      expect(audited).toContain("no plan sets");
    });

    it("flags a contained appId-stamp failure instead of hiding a dark storefront behind ok:true", async () => {
      mocks.publishOwnGroupsMetafield.mockImplementation(async () => ({
        ok: true,
        value: {
          v: 2,
          groupIds: ["77"],
          planIds: ["1", "2"],
          planSets: [["1", "2"]],
          appId: "4477001",
        },
        heal: {
          stamped: [],
          alreadyStamped: [],
          failed: ["gid://shopify/SellingPlanGroup/77"],
        },
      }));

      await goLive(SHOP_DOMAIN, { shiftOverdue: false, actor: "admin@x" });

      const audited = auditedPlanGroups();
      expect(audited).toContain("INCOMPLETE");
      expect(audited).toContain("appId stamp failed");
      expect(audited).toContain("gid://shopify/SellingPlanGroup/77");
    });

    it("flags an allow-list with group ids but NO plan ids as incomplete", async () => {
      // Exactly what publishOwnGroupsMetafield() emits when the plan-id repair
      // cannot read the group back from Shopify.
      mocks.publishOwnGroupsMetafield.mockImplementation(async () => ({
        ok: true,
        value: { v: 1, groupIds: ["77"], planIds: [] },
      }));

      await goLive(SHOP_DOMAIN, { shiftOverdue: false, actor: "admin@x" });

      const audited = auditedPlanGroups();
      expect(audited).toContain("INCOMPLETE");
      expect(audited).toContain("renders nothing");
      // It must NOT read as a plain success.
      expect(audited).not.toBe("published");
    });

    it("flags an allow-list with no groups at all as empty", async () => {
      mocks.publishOwnGroupsMetafield.mockImplementation(async () => ({
        ok: true,
        value: { v: 1, groupIds: [], planIds: [] },
      }));

      await goLive(SHOP_DOMAIN, { shiftOverdue: false, actor: "admin@x" });

      expect(auditedPlanGroups()).toContain("EMPTY");
    });

    it("still reports an outright failure as failed", async () => {
      mocks.publishOwnGroupsMetafield.mockImplementation(async () => ({
        ok: false,
        error: "throttled",
      }));

      await goLive(SHOP_DOMAIN, { shiftOverdue: false, actor: "admin@x" });

      expect(auditedPlanGroups()).toBe("failed: throttled");
    });
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

  it("staggers every overdue renewal BEFORE the mode flips (no burst window)", async () => {
    // THE regression: goLive used to flip the setting LIVE first and stagger
    // afterwards. The billing sweep has no goLive awareness — it gates on the
    // launch SETTING and ticks every 5 minutes — so on a migration store with
    // hundreds of overdue imported contracts the tick could land mid-stagger,
    // see isSetupMode() === false, and charge every not-yet-shifted contract
    // the same day, breaking the exact promise of "Shift these renewals
    // forward". Pin the closure: while ANY shift runs the shop is still
    // SETUP, and only after the last shift does anything flip.
    mocks.contractFindMany.mockImplementation(async () => [
      {
        id: "c_1",
        shopifyContractId: "gid://shopify/SubscriptionContract/1",
        email: "a@example.com",
        firstName: null,
        lastName: null,
        nextBillingDate: new Date("2026-07-01T00:00:00Z"),
      },
      {
        id: "c_2",
        shopifyContractId: "gid://shopify/SubscriptionContract/2",
        email: "b@example.com",
        firstName: null,
        lastName: null,
        nextBillingDate: new Date("2026-07-02T00:00:00Z"),
      },
    ]);
    const modesDuringShift: string[] = [];
    mocks.setNextBillingDate.mockImplementation(async () => {
      modesDuringShift.push(storedLaunch().mode);
      return {};
    });

    const result = await goLive(SHOP_DOMAIN, {
      shiftOverdue: true,
      actor: "admin@x",
    });

    expect(result.shifted).toBe(2);
    // A gated billing sweep firing at any point during the stagger loop
    // would have seen SETUP and skipped — the burst window does not exist.
    expect(modesDuringShift).toEqual(["SETUP", "SETUP"]);
    expect(storedLaunch().mode).toBe("LIVE");
    // And the storefront flag (the flip's first side effect) is only written
    // after the last shift.
    const lastShift = Math.max(
      ...mocks.setNextBillingDate.mock.invocationCallOrder,
    );
    expect(mocks.setShopMetafield.mock.invocationCallOrder[0]).toBeGreaterThan(
      lastShift,
    );
  });

  it("a failed flag write after the stagger leaves only postponed renewals", async () => {
    // The deliberate trade of shifting first: when the metafield write then
    // fails, the shifted dates stay (renewals harmlessly postponed 1-3 days,
    // no charge made) — a far cheaper failure than the same-day charge burst
    // the old order allowed. The mode still rolls back so the app never
    // claims LIVE over a dark storefront, and no go-live audit event is
    // logged for a launch that did not take.
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
    ).rejects.toThrow(/postponed by 1-3 days/);

    expect(mocks.setNextBillingDate).toHaveBeenCalledTimes(1);
    expect(storedLaunch().mode).toBe("SETUP");
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});

// ── goLive re-attributes contracts before anything can bill ──────────────────

/**
 * Migration 0003 leaves every pre-existing mirrored contract UNKNOWN — safe
 * (UNKNOWN is never billed) but incomplete, because our OWN subscribers are in
 * there too. Going live is what starts the billing sweep, so it is the one
 * moment where re-attribution is guaranteed to have happened first. Before
 * this, the reclassification existed but had no caller anywhere in the app:
 * the contracts stayed as the migration left them.
 *
 * It must also be the FULL sweep, not the single bounded pass: the pass is
 * capped, so calling it once left every contract past the cap UNKNOWN — our
 * own subscribers among them — and therefore unbilled, with nothing in the
 * product re-running it.
 */
describe("goLive ownership pass", () => {
  it("re-classifies contracts BEFORE the mode flips", async () => {
    let modeWhenReclassified: string | null = null;
    mocks.reclassifyAllContracts.mockImplementation(async () => {
      modeWhenReclassified = storedLaunch().mode;
      return {
        scanned: 3,
        changed: 2,
        resynced: 1,
        errors: 0,
        remaining: 0,
        counts: { ours: 2, foreign: 1, unknown: 0 },
      };
    });

    const result = await goLive(SHOP_DOMAIN, { shiftOverdue: false, actor: "admin@x" });

    expect(mocks.reclassifyAllContracts).toHaveBeenCalledWith(SHOP_DOMAIN);
    // Nothing billable existed while the pass was running.
    expect(modeWhenReclassified).toBe("SETUP");
    expect(result.ownership?.changed).toBe(2);
    expect(result.ownershipError).toBeNull();
    expect(storedLaunch().mode).toBe("LIVE");
  });

  it("sweeps EVERY contract, not one capped pass", async () => {
    // The regression: go-live called the bounded pass, which stops at
    // RECLASSIFY_DEFAULT_LIMIT rows. A shop with more contracts than that went
    // live with the overflow still UNKNOWN — and UNKNOWN is not billable, so
    // those renewals stopped — while nothing anywhere re-ran the pass. Only an
    // admin who noticed the number on Preview & launch and pressed Re-check
    // over and over would ever have finished the job.
    await goLive(SHOP_DOMAIN, { shiftOverdue: false, actor: "admin@x" });

    expect(mocks.reclassifyAllContracts).toHaveBeenCalledTimes(1);
    expect(mocks.reclassifyContracts).not.toHaveBeenCalled();
  });

  it("records the pass in the go-live audit event", async () => {
    await goLive(SHOP_DOMAIN, { shiftOverdue: false, actor: "admin@x" });
    const payload = (mocks.logEvent.mock.calls[0][0] as {
      payload: Record<string, unknown>;
    }).payload;
    expect(payload.ownershipReclassified).toMatchObject({
      scanned: 0,
      counts: { ours: 0, foreign: 0, unknown: 0 },
    });
  });

  it("goes live anyway when the pass fails — the failure is the SAFE direction", async () => {
    // A contract that was never attributed stays UNKNOWN, and UNKNOWN is not
    // billable. So a failed pass can only delay OUR renewals, never charge
    // someone else's subscriber — blocking go-live over it would be worse.
    mocks.reclassifyAllContracts.mockRejectedValueOnce(new Error("Shopify 502"));

    const result = await goLive(SHOP_DOMAIN, { shiftOverdue: false, actor: "admin@x" });

    expect(storedLaunch().mode).toBe("LIVE");
    expect(result.ownership).toBeNull();
    expect(result.ownershipError).toContain("Shopify 502");
    // …and it is on the audit trail, so "why is nothing billing?" is answerable.
    const payload = (mocks.logEvent.mock.calls[0][0] as {
      payload: Record<string, unknown>;
    }).payload;
    expect(String(payload.ownershipReclassified)).toContain("Shopify 502");
  });
});

// ── The overdue list go-live staggers ────────────────────────────────────────

describe("getOverdueContracts", () => {
  it("only ever lists contracts we own", async () => {
    // This list is not just displayed: goLive REWRITES the next billing date
    // of everything on it via setNextBillingDate, which edits the contract on
    // Shopify. Another app's overdue contract is neither a charge we were
    // going to make nor a date we may move.
    await getOverdueContracts("shop_1");
    const where = (mocks.contractFindMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    }).where;
    expect(where).toMatchObject({
      shopId: "shop_1",
      status: "ACTIVE",
      isDemo: false,
      ownership: "OURS",
    });
  });

  it("staggers only our own overdue renewals on go-live", async () => {
    mocks.contractFindMany.mockImplementation(async (args?: unknown) => {
      const where = (args as { where: Record<string, unknown> }).where;
      // The mock enforces the filter the query asked for, so a dropped
      // OURS_ONLY would show up as a foreign contract being rescheduled.
      const rows = [
        {
          id: "ours",
          ownership: "OURS",
          shopifyContractId: "gid://shopify/SubscriptionContract/1",
          email: "a@example.com",
          firstName: null,
          lastName: null,
          nextBillingDate: new Date("2026-07-01T00:00:00Z"),
        },
        {
          id: "joys",
          ownership: "FOREIGN",
          shopifyContractId: "gid://shopify/SubscriptionContract/2",
          email: "b@example.com",
          firstName: null,
          lastName: null,
          nextBillingDate: new Date("2026-07-01T00:00:00Z"),
        },
      ];
      return rows.filter(
        (row) => !where.ownership || row.ownership === where.ownership,
      );
    });

    const result = await goLive(SHOP_DOMAIN, { shiftOverdue: true, actor: "admin@x" });

    expect(result.shifted).toBe(1);
    expect(mocks.setNextBillingDate).toHaveBeenCalledTimes(1);
    expect(mocks.setNextBillingDate).toHaveBeenCalledWith(
      SHOP_DOMAIN,
      "ours",
      expect.any(Date),
      expect.objectContaining({ source: "ADMIN" }),
    );
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
