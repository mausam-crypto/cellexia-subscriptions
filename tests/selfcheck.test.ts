import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The live self-check engine (Debug tab, v1.9.0). Pins the contracts the
 * merchant relies on:
 *
 *  - REGISTRY: every check has a unique key and appears in every report —
 *    a check that silently vanishes is a hole in the safety net.
 *  - CONTAINMENT: a throwing check reports FAIL with the error; the run
 *    always completes and the other checks still report.
 *  - VERDICT: any FAIL → BROKEN, any WARN → DEGRADED, else HEALTHY.
 *  - ALERTING: BROKEN raises ONE deduped CRITICAL SELF_CHECK_FAILED alert
 *    (the path that emails the admins); a clean run auto-resolves it.
 *  - PERSISTENCE: the report is written to the machine-written `selfCheck`
 *    setting and round-trips its registry schema (the Debug page reads it
 *    back through getSetting, whose junk fallback would silently discard a
 *    non-conforming report).
 *  - JOB: selfcheck_run is registered and NOT setup-gated — the whole point
 *    is catching a broken live store BEFORE go-live.
 */

process.env.APP_SIGNING_SECRET = "test-secret-for-selfcheck";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.SHOPIFY_API_KEY = "test-key";
process.env.SHOPIFY_API_SECRET = "test-secret";
process.env.SHOPIFY_APP_URL = "https://app.example.com";
process.env.SCOPES = "read_products,write_products";
delete process.env.SCHEDULER_MODE;

const mocks = vi.hoisted(() => {
  const recentRun = () => ({
    status: "SUCCESS",
    startedAt: new Date(Date.now() - 60_000),
    error: null,
    stats: null,
  });
  return {
    queryRaw: vi.fn(async (strings: TemplateStringsArray): Promise<unknown> => {
      const q = strings.join("?");
      if (q.includes("_prisma_migrations")) return [];
      if (q.includes("db_now")) return [{ db_now: new Date() }];
      if (q.includes("BillingAttempt")) return [];
      return [{ ok: 1 }];
    }),
    jobRunFindFirst: vi.fn(
      async (args?: {
        where?: { jobName?: string };
      }): Promise<unknown> =>
        args?.where?.jobName ? recentRun() : { id: "jr_1" },
    ),
    webhookReceiptFindFirst: vi.fn(async (): Promise<unknown> => ({
      receivedAt: new Date(Date.now() - 3_600_000),
      topic: "ORDERS_CREATE",
    })),
    webhookReceiptCount: vi.fn(async (): Promise<number> => 0),
    contractCount: vi.fn(async (): Promise<number> => 0),
    contractFindFirst: vi.fn(async (): Promise<unknown> => null),
    planConfigFindMany: vi.fn(async (): Promise<unknown[]> => [
      {
        name: "Default plan",
        syncStatus: "SYNCED",
        syncError: null,
        shopifyGroupId: "gid://shopify/SellingPlanGroup/1",
        productIds: ["gid://shopify/Product/1"],
      },
    ]),
    billingAttemptCount: vi.fn(async (): Promise<number> => 0),
    dunningCaseCount: vi.fn(async (): Promise<number> => 0),
    outboxCount: vi.fn(async (): Promise<number> => 0),
    outboxFindFirst: vi.fn(async (): Promise<unknown> => null),
    notificationLogCount: vi.fn(async (): Promise<number> => 0),
    settingFindMany: vi.fn(async (): Promise<unknown[]> => []),
    alertFindMany: vi.fn(async (): Promise<unknown[]> => []),
    alertUpdateMany: vi.fn(async (): Promise<{ count: number }> => ({
      count: 1,
    })),
    jobLockFindMany: vi.fn(async (): Promise<unknown[]> => []),
    subscriberEventCount: vi.fn(async (): Promise<number> => 0),
    // gift_promises fixture: a fully-aligned gift setup (cycle-2 + milestone
    // rules, an anniversary rule, a stocked pool) so the healthy run stays
    // healthy; tests that probe the check override these.
    giftRuleFindMany: vi.fn(async (): Promise<unknown[]> => [
      {
        trigger: "ORDER_INDEX",
        orderIndex: 2,
        daysSubscribed: null,
        selection: "FIXED",
      },
      {
        trigger: "ORDER_INDEX",
        orderIndex: 6,
        daysSubscribed: null,
        selection: "FIXED",
      },
      {
        trigger: "DAYS_SUBSCRIBED",
        orderIndex: null,
        daysSubscribed: 365,
        selection: "FIXED",
      },
    ]),
    setSetting: vi.fn(async (): Promise<void> => {}),
    raiseAlert: vi.fn(async (): Promise<boolean> => true),
    logEvent: vi.fn(async (): Promise<void> => {}),
    probeProxyIdentity: vi.fn(async (): Promise<unknown> => ({
      status: "OK",
      url: "https://cellexialabs.com/apps/cellexia-subs/preview/validate",
      detail: null,
    })),
    probeKlaviyoKey: vi.fn(async (): Promise<unknown> => ({
      ok: true,
      detail: "Klaviyo accepted the key.",
    })),
    getProducts: vi.fn(async (): Promise<unknown[]> => [
      {
        id: "gid://shopify/Product/1",
        title: "Renewal Serum",
        handle: "renewal-serum",
        status: "ACTIVE",
        totalInventory: 10,
        featuredImageUrl: null,
      },
    ]),
    launchMode: { value: "LIVE" as "LIVE" | "SETUP" },
    klaviyoConfigured: { value: true },
    // Mutable per-key setting values the new checks read.
    dunningSetting: {
      value: {
        softRetryDays: [0, 3, 7, 14],
        paydayAlign: true,
        paydaysOfMonth: [1, 15, 25],
        paydaySnapWindowDays: 3,
        emailLadderDays: [0, 3, 7],
        smsDay: 8,
        preExpiryNoticeDays: 30,
        backupPaymentFallback: true,
        exhaustedAction: "PAUSE",
        cancelAfterFailedDays: 30,
      },
    },
    emailsSetting: { value: { templates: {} as Record<string, unknown> } },
    flowSetupSetting: {
      value: {
        checkedAt: null as string | null,
        lastAttemptAt: null as string | null,
        setupRanAt: null as string | null,
        rows: [] as Array<Record<string, unknown>>,
      },
    },
    klaviyoSetting: { value: { privateApiKey: "" } },
    mailTransportSetting: { value: { smtpPass: "" } },
    // v1.25.0 market visibility: the setting + the raw metafield the theme
    // reads (null = never written = every market).
    widgetMarketsSetting: {
      value: { mode: "all", handles: [] as string[] } as {
        mode: "all" | "selected";
        handles: string[];
      },
    },
    widgetMarketsMetafield: { value: null as string | null },
    // The shop's live market list (primary first) — what widget_markets
    // audits saved handles against and what storefront_widget uses to name
    // the market the probed primary domain serves.
    listMarkets: vi.fn(async (): Promise<unknown[]> => [
      { id: "gid://shopify/Market/1", name: "Switzerland", handle: "ch", primary: true, enabled: true },
      { id: "gid://shopify/Market/2", name: "Germany", handle: "de", primary: false, enabled: true },
    ]),
  };
});

vi.mock("~/db.server", () => ({
  default: {
    $queryRaw: mocks.queryRaw,
    jobRun: { findFirst: mocks.jobRunFindFirst },
    webhookReceipt: {
      findFirst: mocks.webhookReceiptFindFirst,
      count: mocks.webhookReceiptCount,
    },
    subscriptionContract: {
      count: mocks.contractCount,
      findFirst: mocks.contractFindFirst,
    },
    sellingPlanConfig: { findMany: mocks.planConfigFindMany },
    billingAttempt: { count: mocks.billingAttemptCount },
    dunningCase: { count: mocks.dunningCaseCount },
    klaviyoOutbox: {
      count: mocks.outboxCount,
      findFirst: mocks.outboxFindFirst,
    },
    notificationLog: { count: mocks.notificationLogCount },
    setting: { findMany: mocks.settingFindMany },
    alert: {
      findMany: mocks.alertFindMany,
      updateMany: mocks.alertUpdateMany,
    },
    jobLock: { findMany: mocks.jobLockFindMany },
    subscriberEvent: { count: mocks.subscriberEventCount },
    giftRule: { findMany: mocks.giftRuleFindMany },
  },
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/lib/shop/install.server", () => ({
  requireShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    primaryDomain: "cellexialabs.com",
  })),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
  })),
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "dunning") return mocks.dunningSetting.value;
    if (key === "selfCheck") return { version: 1, lastReport: null };
    if (key === "emails") return mocks.emailsSetting.value;
    if (key === "emailDesign") return {}; // normalizeEmailDesign fills defaults
    if (key === "klaviyoFlowSetup") return mocks.flowSetupSetting.value;
    if (key === "klaviyo") return mocks.klaviyoSetting.value;
    if (key === "mailTransport") return mocks.mailTransportSetting.value;
    if (key === "widgetMarkets") return mocks.widgetMarketsSetting.value;
    if (key === "lifecycle") {
      return {
        surpriseGiftOnCycle2: true,
        milestoneGiftCycle: 6,
        anniversaryGiftDays: 365,
        rewardsUnlockDay: 90,
        earlyCycleIncentivesEnabled: true,
        milestoneLadder: [12, 18, 24],
        rewardsGiftEnabled: true,
      };
    }
    if (key === "cancelFlow") return { giftSaveEnabled: true };
    if (key === "gifts") {
      return {
        pool: [
          {
            variantId: "gid://shopify/ProductVariant/9",
            variantTitle: "Travel serum",
            unitCostCents: 240,
          },
        ],
        pairings: {},
        surveyPairings: {},
        maxGiftsPerCycle: 1,
      };
    }
    return {};
  }),
  setSetting: mocks.setSetting,
}));

vi.mock("~/lib/graphql/metafields.server", () => ({
  getShopMetafield: vi.fn(
    async (_admin: unknown, _namespace: string, key: string): Promise<unknown> => {
      if (key === "widget_markets") {
        return mocks.widgetMarketsMetafield.value === null
          ? null
          : {
              id: "gid://shopify/Metafield/2",
              namespace: "cellexia",
              key: "widget_markets",
              type: "json",
              value: mocks.widgetMarketsMetafield.value,
            };
      }
      return {
        id: "gid://shopify/Metafield/1",
        namespace: "cellexia",
        key: "plan_groups",
        type: "json",
        value: JSON.stringify({
          v: 2,
          groupIds: ["1"],
          planIds: ["11"],
          planSets: [["11"]],
          appId: "4242",
        }),
      };
    },
  ),
}));

vi.mock("~/lib/graphql/sellingPlans.server", () => ({
  getCurrentAppId: vi.fn(async (): Promise<string> => "4242"),
}));

vi.mock("~/lib/graphql/markets.server", () => ({
  listMarkets: mocks.listMarkets,
}));

vi.mock("~/lib/graphql/appInstallation.server", () => ({
  getGrantedAccessScopes: vi.fn(async (): Promise<string[]> => [
    "read_products",
    "write_products",
  ]),
}));

vi.mock("~/lib/launch/launch.server", () => ({
  getLaunchState: vi.fn(async (): Promise<unknown> => ({
    mode: mocks.launchMode.value,
    wentLiveAt: null,
    confirmedThemeBlock: true,
    confirmedKlaviyo: true,
    previewedStorefront: true,
    previewedPortal: true,
  })),
  readLaunchMetafield: vi.fn(async (): Promise<string | null> =>
    mocks.launchMode.value === "LIVE" ? "live" : "setup",
  ),
  launchFlagDiverged: (mode: string, value: string | null) =>
    (value === "live") !== (mode === "LIVE"),
  probeProxyIdentity: mocks.probeProxyIdentity,
}));

vi.mock("~/lib/notifications/mailer.server", () => ({
  verifyMailer: vi.fn(async (): Promise<unknown> => ({
    ok: true,
    provider: "smtp",
  })),
  // flows.server binds this from the same module (never called here).
  resolveMailConfig: vi.fn(async () => ({ provider: "console" })),
}));

vi.mock("~/lib/klaviyo/client.server", () => ({
  isKlaviyoConfigured: vi.fn(
    async (): Promise<boolean> => mocks.klaviyoConfigured.value,
  ),
  resolveKlaviyoAuth: vi.fn(async (): Promise<unknown> =>
    mocks.klaviyoConfigured.value
      ? { apiKey: "pk_test", revision: "2024-10-15", source: "settings" }
      : { apiKey: null, revision: "2024-10-15", source: null },
  ),
  probeKlaviyoKey: mocks.probeKlaviyoKey,
  // flows.server imports these from the same module; the self-check never
  // calls them, but the mock must still define the names it binds.
  flowsAuth: vi.fn((auth: unknown) => auth),
  klaviyoApiRequest: vi.fn(async () => ({ ok: false, status: 0 })),
  klaviyoApiList: vi.fn(async () => ({ ok: false, status: 0, error: "mock" })),
  klaviyoErrorDetail: vi.fn(() => null),
  createKlaviyoEvent: vi.fn(async () => ({ ok: true, status: 202 })),
  FLOWS_API_REVISION: "2025-01-15",
}));

vi.mock("~/lib/graphql/products.server", () => ({
  getProducts: mocks.getProducts,
}));

vi.mock("~/lib/analytics/alerts.server", () => ({
  raiseAlert: mocks.raiseAlert,
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

import {
  SELF_CHECK_ALERT_TYPE,
  SELF_CHECK_KEYS,
  runSelfCheck,
} from "~/lib/debug/selfcheck.server";
import {
  JOB_NAMES,
  JOB_SCHEDULE,
  SETUP_GATED_JOB_NAMES,
} from "~/lib/jobs/runner.server";
import { settingsSchemas } from "~/lib/settings/registry.server";

/**
 * Storefront + portal fetches answer 200 with the marker each probe expects:
 * product pages carry the buy-box marker (launch-gated exactly when the shop
 * is in SETUP — a healthy theme mirrors the launch metafield), everything
 * else carries the portal marker.
 */
function stubHealthyFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/products/")) {
        const gate =
          mocks.launchMode.value === "LIVE"
            ? ""
            : ' hidden data-cellexia-gated="true"';
        return new Response(
          `<html><div class="cx-buybox" data-cellexia-buybox${gate}></div></html>`,
          { status: 200 },
        );
      }
      return new Response(
        '<html><div class="cxs-portal" data-cellexia-portal></div></html>',
        { status: 200 },
      );
    }),
  );
}

beforeEach(() => {
  // clearAllMocks clears calls, not implementations — re-establish every
  // implementation a test overrides, or scenarios leak into each other.
  vi.clearAllMocks();
  mocks.launchMode.value = "LIVE";
  mocks.klaviyoConfigured.value = true;
  mocks.queryRaw.mockImplementation(
    async (strings: TemplateStringsArray): Promise<unknown> => {
      const q = strings.join("?");
      if (q.includes("_prisma_migrations")) return [];
      if (q.includes("db_now")) return [{ db_now: new Date() }];
      if (q.includes("BillingAttempt")) return [];
      return [{ ok: 1 }];
    },
  );
  mocks.probeProxyIdentity.mockResolvedValue({
    status: "OK",
    url: "https://cellexialabs.com/apps/cellexia-subs/preview/validate",
    detail: null,
  });
  mocks.probeKlaviyoKey.mockResolvedValue({
    ok: true,
    detail: "Klaviyo accepted the key.",
  });
  mocks.getProducts.mockResolvedValue([
    {
      id: "gid://shopify/Product/1",
      title: "Renewal Serum",
      handle: "renewal-serum",
      status: "ACTIVE",
      totalInventory: 10,
      featuredImageUrl: null,
    },
  ]);
  mocks.planConfigFindMany.mockResolvedValue([
    {
      name: "Default plan",
      syncStatus: "SYNCED",
      syncError: null,
      shopifyGroupId: "gid://shopify/SellingPlanGroup/1",
      productIds: ["gid://shopify/Product/1"],
    },
  ]);
  mocks.webhookReceiptFindFirst.mockResolvedValue({
    receivedAt: new Date(Date.now() - 3_600_000),
    topic: "ORDERS_CREATE",
  });
  mocks.contractCount.mockResolvedValue(0);
  mocks.billingAttemptCount.mockResolvedValue(0);
  mocks.alertUpdateMany.mockResolvedValue({ count: 1 });
  mocks.jobLockFindMany.mockResolvedValue([]);
  mocks.subscriberEventCount.mockResolvedValue(0);
  mocks.dunningSetting.value = {
    softRetryDays: [0, 3, 7, 14],
    paydayAlign: true,
    paydaysOfMonth: [1, 15, 25],
    paydaySnapWindowDays: 3,
    emailLadderDays: [0, 3, 7],
    smsDay: 8,
    preExpiryNoticeDays: 30,
    backupPaymentFallback: true,
    exhaustedAction: "PAUSE",
    cancelAfterFailedDays: 30,
  };
  mocks.emailsSetting.value = { templates: {} };
  mocks.flowSetupSetting.value = {
    checkedAt: null,
    lastAttemptAt: null,
    setupRanAt: null,
    rows: [],
  };
  mocks.klaviyoSetting.value = { privateApiKey: "" };
  mocks.mailTransportSetting.value = { smtpPass: "" };
  mocks.widgetMarketsSetting.value = { mode: "all", handles: [] };
  mocks.widgetMarketsMetafield.value = null;
  mocks.listMarkets.mockResolvedValue([
    { id: "gid://shopify/Market/1", name: "Switzerland", handle: "ch", primary: true, enabled: true },
    { id: "gid://shopify/Market/2", name: "Germany", handle: "de", primary: false, enabled: true },
  ]);
  stubHealthyFetch();
});

describe("self-check registry", () => {
  it("has unique keys and a stable, non-trivial check set", () => {
    expect(new Set(SELF_CHECK_KEYS).size).toBe(SELF_CHECK_KEYS.length);
    expect(SELF_CHECK_KEYS.length).toBeGreaterThanOrEqual(20);
    // The features the merchant named when asking for this tab.
    for (const key of [
      "billing_heartbeat",
      "billing_pipeline",
      "double_charge_guard",
      "dunning_cases",
      "portal_endtoend",
      "portal_signing",
      "webhook_delivery",
      "app_proxy",
      "jobs_health",
      // The comprehensive sweep (v1.22.0): live-store shapes local debugging
      // cannot see.
      "storefront_widget",
      "renewal_readiness",
      "dunning_config",
      "job_locks",
      "klaviyo_key_live",
      "klaviyo_flow_coverage",
      "email_templates",
      "stored_secrets",
      "event_provenance",
      // v1.25.0: market visibility setting ⇄ storefront metafield.
      "widget_markets",
    ]) {
      expect(SELF_CHECK_KEYS).toContain(key);
    }
  });
});

describe("runSelfCheck", () => {
  it("reports HEALTHY, persists the report, and auto-resolves its alert", async () => {
    const report = await runSelfCheck("cellexia.myshopify.com", {
      trigger: "job",
    });

    expect(report.verdict).toBe("HEALTHY");
    expect(report.failCount).toBe(0);
    expect(report.checks.map((c) => c.key).sort()).toEqual(
      [...SELF_CHECK_KEYS].sort(),
    );

    // Persisted under the machine-written setting…
    expect(mocks.setSetting).toHaveBeenCalledWith("shop_1", "selfCheck", {
      version: 1,
      lastReport: report,
    });
    // …and the stored shape round-trips the registry schema — otherwise
    // getSetting's junk fallback would silently discard every report.
    const parsed = settingsSchemas.selfCheck.safeParse(
      JSON.parse(JSON.stringify({ version: 1, lastReport: report })),
    );
    expect(parsed.success).toBe(true);

    // Clean run resolves any open SELF_CHECK_FAILED alert, never raises one.
    expect(mocks.raiseAlert).not.toHaveBeenCalled();
    expect(mocks.alertUpdateMany).toHaveBeenCalledWith({
      where: {
        shopId: "shop_1",
        type: SELF_CHECK_ALERT_TYPE,
        resolvedAt: null,
      },
      data: { resolvedAt: expect.any(Date) },
    });
  });

  it("turns a failing probe into BROKEN and raises ONE critical alert", async () => {
    // MISMATCH is deterministic (a real answer from the wrong app) — the
    // one probe outcome that must stay a hard FAIL.
    mocks.probeProxyIdentity.mockResolvedValue({
      status: "MISMATCH",
      url: "https://cellexialabs.com/apps/cellexia-subs/preview/validate",
      detail: "HTTP 404",
    });

    const report = await runSelfCheck("cellexia.myshopify.com");

    expect(report.verdict).toBe("BROKEN");
    const proxy = report.checks.find((c) => c.key === "app_proxy");
    expect(proxy?.status).toBe("FAIL");
    expect(proxy?.remediation).toBeTruthy();

    expect(mocks.raiseAlert).toHaveBeenCalledTimes(1);
    const input = (mocks.raiseAlert.mock.calls[0] as unknown[])[0] as {
      type: string;
      severity: string;
      context: { failed: Array<{ key: string }> };
    };
    expect(input.type).toBe(SELF_CHECK_ALERT_TYPE);
    expect(input.severity).toBe("CRITICAL");
    expect(input.context.failed.map((f) => f.key)).toContain("app_proxy");
    expect(mocks.alertUpdateMany).not.toHaveBeenCalled();
  });

  it("grades a transient network failure WARN after one confirming retry — no CRITICAL email flapping", async () => {
    mocks.probeProxyIdentity.mockResolvedValue({
      status: "UNREACHABLE",
      url: "https://cellexialabs.com/apps/cellexia-subs/preview/validate",
      detail: "network timeout",
    });

    const report = await runSelfCheck("cellexia.myshopify.com");

    // Probed twice (the confirm), then WARN — never a FAIL, never an email.
    expect(mocks.probeProxyIdentity).toHaveBeenCalledTimes(2);
    expect(
      report.checks.find((c) => c.key === "app_proxy")?.status,
    ).toBe("WARN");
    expect(mocks.raiseAlert).not.toHaveBeenCalled();
  });

  it("contains a THROWING check as FAIL and still completes every other check", async () => {
    mocks.queryRaw.mockRejectedValue(new Error("connection refused"));

    const report = await runSelfCheck("cellexia.myshopify.com");

    const database = report.checks.find((c) => c.key === "database");
    expect(database?.status).toBe("FAIL");
    expect(database?.detail).toContain("connection refused");
    // The run never crashed: every registered check reported.
    expect(report.checks).toHaveLength(SELF_CHECK_KEYS.length);
    // And healthy independent checks are still PASS.
    expect(
      report.checks.find((c) => c.key === "portal_signing")?.status,
    ).toBe("PASS");
  });

  it("reports DEGRADED (no alert) when only warnings exist", async () => {
    mocks.planConfigFindMany.mockResolvedValue([]);

    const report = await runSelfCheck("cellexia.myshopify.com");

    expect(
      report.checks.filter((c) => c.status === "FAIL").map((c) => [c.key, c.detail]),
    ).toEqual([]);
    expect(report.verdict).toBe("DEGRADED");
    expect(report.failCount).toBe(0);
    expect(
      report.checks.find((c) => c.key === "selling_plans")?.status,
    ).toBe("WARN");
    expect(mocks.raiseAlert).not.toHaveBeenCalled();
  });

  it("treats webhook silence as quiet — FAIL only when attempts awaited outcomes", async () => {
    // 72h of silence on a live store with active subscribers…
    mocks.webhookReceiptFindFirst.mockResolvedValue({
      receivedAt: new Date(Date.now() - 72 * 3_600_000),
      topic: "ORDERS_CREATE",
    });
    mocks.contractCount.mockImplementation(
      async (args?: {
        where?: { status?: string; nextBillingDate?: unknown; ownership?: unknown };
      }) =>
        // activeOurs for webhook_delivery; the overdue/ownership queries
        // (nextBillingDate / UNKNOWN filters) stay at zero.
        args?.where?.status === "ACTIVE" &&
        !args.where.nextBillingDate &&
        args.where.ownership === "OURS"
          ? 5
          : 0,
    );

    // …but nothing locally awaited a webhook: quiet store, PASS.
    let report = await runSelfCheck("cellexia.myshopify.com");
    expect(
      report.checks.find((c) => c.key === "webhook_delivery")?.status,
    ).toBe("PASS");

    // A charge went out after the last webhook and its outcome never came
    // back — THAT is a dead feed.
    mocks.billingAttemptCount.mockImplementation(
      async (args?: { where?: { startedAt?: { gte?: Date } } }) =>
        args?.where?.startedAt?.gte ? 2 : 0,
    );
    report = await runSelfCheck("cellexia.myshopify.com");
    expect(
      report.checks.find((c) => c.key === "webhook_delivery")?.status,
    ).toBe("FAIL");
  });

  it("scopes the dunning stall queries to what the sweep actually owns", async () => {
    await runSelfCheck("cellexia.myshopify.com");

    const wheres = mocks.dunningCaseCount.mock.calls.map(
      (call) =>
        (call as unknown as [{ where: Record<string, unknown> }])[0].where,
    );
    const zombie = wheres.find(
      (w) => w.state === "RETRYING" && w.nextRetryAt === null,
    ) as { contract: { is: Record<string, unknown> } };
    const behind = wheres.find(
      (w) =>
        w.state === "RETRYING" &&
        w.nextRetryAt !== null &&
        typeof w.nextRetryAt === "object",
    ) as { contract: { is: Record<string, unknown> } };

    // In-flight retries (PENDING attempt awaiting its outcome webhook) are
    // the NORMAL RETRYING+null shape — only the attemptless one is a zombie.
    expect(zombie.contract.is.billingAttempts).toEqual({
      none: { status: "PENDING" },
    });
    // The sweep skips PAUSED contracts on purpose; so must the stall count.
    expect(behind.contract.is.status).toEqual({ not: "PAUSED" });
  });

  it("billing_pipeline gives the stale sweep a full cadence of slack before calling PENDING stuck", async () => {
    // The stale sweep only becomes ELIGIBLE to expire an unresolved PENDING
    // attempt at exactly 24h (scheduler STALE_EXPIRE_HOURS) and runs every 30
    // minutes — an attempt aged 24h–24h30m is inside its normal operating
    // envelope, not evidence of a broken sweep. With a bare 24h threshold the
    // 30-min selfcheck tick firing between sweep ticks flipped the verdict
    // BROKEN and emailed the admins a CRITICAL that self-resolved minutes
    // later, when the sweep expired the attempt exactly on schedule. The
    // threshold is 25h: expiry + one full cadence + slack, matching the
    // padded siblings (SETTLEMENT_LAG_HOURS, FAILED_UNSETTLED_MINUTES).
    const countPendingOlderThanCutoff = (ageHours: number) => {
      const attemptStartedAt = new Date(Date.now() - ageHours * 3_600_000);
      mocks.billingAttemptCount.mockImplementation(
        async (args?: unknown): Promise<number> => {
          const where = (args as {
            where?: {
              status?: string;
              OR?: Array<{ startedAt?: { lte?: Date } }>;
            };
          })?.where;
          if (where?.status !== "PENDING") return 0;
          const cutoff = where.OR?.[0]?.startedAt?.lte;
          if (!(cutoff instanceof Date)) return 0;
          return attemptStartedAt.getTime() <= cutoff.getTime() ? 1 : 0;
        },
      );
    };

    // 24h12m old: past the sweep's expiry boundary but within its cadence
    // window — the next sweep tick handles it. Not a FAIL.
    countPendingOlderThanCutoff(24.2);
    let report = await runSelfCheck("cellexia.myshopify.com");
    expect(
      report.checks.find((c) => c.key === "billing_pipeline")?.status,
    ).toBe("PASS");
    expect(mocks.raiseAlert).not.toHaveBeenCalled();

    // 26h old: a whole cadence (and more) past expiry — the sweep really is
    // not doing its job.
    countPendingOlderThanCutoff(26);
    report = await runSelfCheck("cellexia.myshopify.com");
    const check = report.checks.find((c) => c.key === "billing_pipeline");
    expect(check?.status).toBe("FAIL");
    expect(check?.detail).toContain("over 25h");
  });

  it("skips the overdue-renewals check while billing is setup-gated", async () => {
    mocks.launchMode.value = "SETUP";

    const report = await runSelfCheck("cellexia.myshopify.com");

    expect(
      report.checks.find((c) => c.key === "billing_overdue")?.status,
    ).toBe("SKIP");
  });

  it("audits manual runs, not job runs", async () => {
    await runSelfCheck("cellexia.myshopify.com", { trigger: "job" });
    expect(mocks.logEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ action: "self_check_run" }),
      }),
    );

    await runSelfCheck("cellexia.myshopify.com", {
      trigger: "admin",
      actor: "ops@example.com",
    });
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "admin.action",
        actor: "ops@example.com",
        payload: expect.objectContaining({ action: "self_check_run" }),
      }),
    );
  });
});

describe("the comprehensive live-store checks (v1.22.0)", () => {
  function checkOf(report: Awaited<ReturnType<typeof runSelfCheck>>, key: string) {
    return report.checks.find((c) => c.key === key);
  }

  it("storefront_widget FAILs when the LIVE store's product page is missing the widget", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/products/")
          ? new Response("<html><main>theme without our markup</main></html>", {
              status: 200,
            })
          : new Response(
              '<html><div class="cxs-portal" data-cellexia-portal></div></html>',
              { status: 200 },
            ),
      ),
    );

    const report = await runSelfCheck("cellexia.myshopify.com");
    const check = checkOf(report, "storefront_widget");
    expect(check?.status).toBe("FAIL");
    expect(check?.detail).toContain("sells nothing");
  });

  it("storefront_widget FAILs when the widget is still launch-gated on a LIVE store", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/products/")
          ? new Response(
              '<html><div class="cx-buybox" data-cellexia-buybox hidden data-cellexia-gated="true"></div></html>',
              { status: 200 },
            )
          : new Response(
              '<html><div class="cxs-portal" data-cellexia-portal></div></html>',
              { status: 200 },
            ),
      ),
    );

    const report = await runSelfCheck("cellexia.myshopify.com");
    const check = checkOf(report, "storefront_widget");
    expect(check?.status).toBe("FAIL");
    expect(check?.detail).toContain("launch-gated");
  });

  it("storefront_widget FAILs when the widget is VISIBLE while the app is in SETUP", async () => {
    mocks.launchMode.value = "SETUP";
    // The stub renders gated markup in SETUP; force an UNGATED page instead.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/products/")
          ? new Response(
              '<html><div class="cx-buybox" data-cellexia-buybox></div></html>',
              { status: 200 },
            )
          : new Response(
              '<html><div class="cxs-portal" data-cellexia-portal></div></html>',
              { status: 200 },
            ),
      ),
    );

    const report = await runSelfCheck("cellexia.myshopify.com");
    const check = checkOf(report, "storefront_widget");
    expect(check?.status).toBe("FAIL");
    expect(check?.detail).toContain("SETUP");
  });

  it("storefront_widget PASSes a correctly gated SETUP store; a marker-less SETUP page is WARN, not FAIL", async () => {
    mocks.launchMode.value = "SETUP";
    let report = await runSelfCheck("cellexia.myshopify.com");
    expect(checkOf(report, "storefront_widget")?.status).toBe("PASS");

    // Theme block not enabled yet: a pre-go-live nudge, never an outage.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/products/")
          ? new Response("<html>theme without our markup</html>", {
              status: 200,
            })
          : new Response(
              '<html><div class="cxs-portal" data-cellexia-portal></div></html>',
              { status: 200 },
            ),
      ),
    );
    report = await runSelfCheck("cellexia.myshopify.com");
    expect(checkOf(report, "storefront_widget")?.status).toBe("WARN");
  });

  // ── v1.25.0 market visibility ─────────────────────────────────────────────

  /** The excluded-market page: only the inert marker, no gate, no widget. */
  function stubMarketHiddenFetch(handle: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/products/")
          ? new Response(
              `<html><!-- BEGIN app snippet: cx-buybox-core --><template class="cx-buybox-nogroup" data-cellexia-market-hidden hidden style="display:none!important" data-cellexia-diag-market="${handle}"></template><!-- END app snippet --></html>`,
              { status: 200 },
            )
          : new Response(
              '<html><div class="cxs-portal" data-cellexia-portal></div></html>',
              { status: 200 },
            ),
      ),
    );
  }

  it("storefront_widget PASSes a market-hidden page when the setting excludes that market — the launch gate is not judged (LIVE and SETUP alike)", async () => {
    mocks.widgetMarketsSetting.value = { mode: "selected", handles: ["ch"] };
    stubMarketHiddenFetch("fr");

    for (const mode of ["LIVE", "SETUP"] as const) {
      mocks.launchMode.value = mode;
      const report = await runSelfCheck("cellexia.myshopify.com");
      const check = checkOf(report, "storefront_widget");
      expect(check?.status, mode).toBe("PASS");
      expect(check?.detail).toContain("“fr”");
      expect(check?.detail).toContain("market setting");
    }
  });

  it("storefront_widget PASSes a market-hidden page with a BLANK handle under “Only these markets” (fails closed as designed)", async () => {
    mocks.widgetMarketsSetting.value = { mode: "selected", handles: ["ch"] };
    stubMarketHiddenFetch("");
    const report = await runSelfCheck("cellexia.myshopify.com");
    const check = checkOf(report, "storefront_widget");
    expect(check?.status).toBe("PASS");
    expect(check?.detail).toContain("no market handle");
  });

  it("storefront_widget FAILs a market-hidden page when the setting ALLOWS that market (metafield drift) — with the re-save fix", async () => {
    // Setting says all markets, but the theme hides "ch": the metafield the
    // storefront reads is not the one the app believes it published.
    mocks.widgetMarketsSetting.value = { mode: "all", handles: [] };
    stubMarketHiddenFetch("ch");
    let report = await runSelfCheck("cellexia.myshopify.com");
    let check = checkOf(report, "storefront_widget");
    expect(check?.status).toBe("FAIL");
    expect(check?.detail).toContain("“ch”");
    expect(check?.detail).toContain("app allows");
    expect(check?.remediation).toContain("Where the buy box shows");

    // Same with a selected list that DOES include the hidden market.
    mocks.widgetMarketsSetting.value = { mode: "selected", handles: ["ch", "de"] };
    report = await runSelfCheck("cellexia.myshopify.com");
    check = checkOf(report, "storefront_widget");
    expect(check?.status).toBe("FAIL");
  });

  it("storefront_widget: the market marker never masquerades as a gate verdict — a LIVE store with a plain gated page still FAILs", async () => {
    // Regression guard on the ordering: the marker check runs first, but a
    // page WITHOUT the marker goes through the untouched gate logic.
    mocks.widgetMarketsSetting.value = { mode: "selected", handles: ["ch"] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/products/")
          ? new Response(
              '<html><div class="cx-buybox" data-cellexia-buybox hidden data-cellexia-gated="true"></div></html>',
              { status: 200 },
            )
          : new Response(
              '<html><div class="cxs-portal" data-cellexia-portal></div></html>',
              { status: 200 },
            ),
      ),
    );
    const report = await runSelfCheck("cellexia.myshopify.com");
    expect(checkOf(report, "storefront_widget")?.status).toBe("FAIL");
  });

  it("storefront_widget FAILs the INVERSE drift: the widget is rendered on the primary market although the setting excludes it (stale extension / stale metafield)", async () => {
    // The v1.25.0 ZIP applied without `npm run deploy`: the theme still runs
    // the pre-v1.25.0 Liquid, which ignores the metafield and renders the
    // widget everywhere. Setting says "only de", the probe hits the primary
    // domain (= primary market "ch"), and setting ⇄ metafield still agree
    // (widget_markets stays PASS) — only this probe can see it.
    mocks.widgetMarketsSetting.value = { mode: "selected", handles: ["de"] };
    mocks.widgetMarketsMetafield.value = JSON.stringify({ v: 1, mode: "selected", handles: ["de"] });
    for (const mode of ["LIVE", "SETUP"] as const) {
      // LIVE renders the ungated widget, SETUP the gated one — a gated render
      // in an excluded market is the same proof (market-hidden wins over the
      // launch gate in the deployed Liquid).
      mocks.launchMode.value = mode;
      const report = await runSelfCheck("cellexia.myshopify.com");
      const check = checkOf(report, "storefront_widget");
      expect(check?.status, mode).toBe("FAIL");
      expect(check?.detail).toContain("“ch”");
      expect(check?.detail).toContain("excluded by your setting");
      expect(check?.detail).toContain("only de");
      expect(check?.remediation).toContain("npm run deploy");
      expect(check?.remediation).toContain("Re-sync");
      expect(checkOf(report, "widget_markets")?.status).toBe("PASS");
    }
  });

  it("storefront_widget: the widget rendered on a primary market the setting INCLUDES is the ordinary verdict (no false drift)", async () => {
    mocks.widgetMarketsSetting.value = { mode: "selected", handles: ["ch"] };
    mocks.widgetMarketsMetafield.value = JSON.stringify({ v: 1, mode: "selected", handles: ["ch"] });
    const report = await runSelfCheck("cellexia.myshopify.com");
    const check = checkOf(report, "storefront_widget");
    expect(check?.status).toBe("PASS");
    expect(check?.detail).toContain("visible as expected");
    expect(check?.detail).not.toContain("Could not");
    // Under "all" the market list is never consulted for this probe.
    mocks.widgetMarketsSetting.value = { mode: "all", handles: [] };
    mocks.listMarkets.mockClear();
    await runSelfCheck("cellexia.myshopify.com");
    expect(mocks.listMarkets).not.toHaveBeenCalled();
  });

  it("storefront_widget: a page that REDIRECTED elsewhere (market subfolder) is not judged for inverse drift — the rendered market is unknown", async () => {
    // Shopify's location redirect can land the app host on /en-us/… — a
    // market that is not the primary one, so "widget rendered + primary
    // excluded" would be a false FAIL. Note, not verdict.
    mocks.widgetMarketsSetting.value = { mode: "selected", handles: ["de"] };
    mocks.widgetMarketsMetafield.value = JSON.stringify({ v: 1, mode: "selected", handles: ["de"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/products/")
          ? ({
              ok: true,
              status: 200,
              url: "https://cellexialabs.com/en-us/products/renewal-serum",
              text: async (): Promise<string> =>
                '<html><div class="cx-buybox" data-cellexia-buybox></div></html>',
            } as unknown as Response)
          : new Response('<html><div class="cxs-portal" data-cellexia-portal></div></html>', { status: 200 }),
      ),
    );
    const report = await runSelfCheck("cellexia.myshopify.com");
    const check = checkOf(report, "storefront_widget");
    expect(check?.status).toBe("PASS");
    expect(check?.detail).toContain("redirected to https://cellexialabs.com/en-us/products/renewal-serum");
    expect(check?.detail).toContain("market rule was not judged");
    // Only the widget_markets audit read the market list — this probe did not.
    expect(mocks.listMarkets).toHaveBeenCalledTimes(1);
  });

  it("storefront_widget: an unreadable market list skips the inverse-drift judgement with a note — the gate verdict stands", async () => {
    mocks.widgetMarketsSetting.value = { mode: "selected", handles: ["de"] };
    mocks.widgetMarketsMetafield.value = JSON.stringify({ v: 1, mode: "selected", handles: ["de"] });
    mocks.listMarkets.mockRejectedValue(new Error("read_markets denied"));
    const report = await runSelfCheck("cellexia.myshopify.com");
    const check = checkOf(report, "storefront_widget");
    expect(check?.status).toBe("PASS");
    expect(check?.detail).toContain("visible as expected");
    expect(check?.detail).toContain("Could not verify the market rule");
    expect(check?.detail).toContain("read_markets denied");
  });

  it("widget_markets WARNs when a saved handle is no longer a market or is a draft/disabled market, naming the remaining live ones", async () => {
    mocks.widgetMarketsSetting.value = { mode: "selected", handles: ["ch", "eu", "gone"] };
    mocks.widgetMarketsMetafield.value = JSON.stringify({ v: 1, mode: "selected", handles: ["ch", "eu", "gone"] });
    mocks.listMarkets.mockResolvedValue([
      { id: "gid://shopify/Market/1", name: "Switzerland", handle: "ch", primary: true, enabled: true },
      { id: "gid://shopify/Market/9", name: "EU (draft)", handle: "eu", primary: false, enabled: false },
    ]);
    const report = await runSelfCheck("cellexia.myshopify.com");
    const check = checkOf(report, "widget_markets");
    expect(check?.status).toBe("WARN");
    expect(check?.detail).toContain("“gone” is no longer a market");
    expect(check?.detail).toContain("“eu” is a draft/disabled market");
    expect(check?.detail).toContain("remaining 1: ch");
    expect(check?.remediation).toContain("Where the buy box shows");
    expect(check?.remediation).toContain("edit the list");
  });

  it("widget_markets FAILs when NONE of the saved handles is a live market — hidden everywhere with setting and metafield in agreement", async () => {
    mocks.widgetMarketsSetting.value = { mode: "selected", handles: ["eu"] };
    mocks.widgetMarketsMetafield.value = JSON.stringify({ v: 1, mode: "selected", handles: ["eu"] });
    mocks.listMarkets.mockResolvedValue([
      { id: "gid://shopify/Market/1", name: "Switzerland", handle: "ch", primary: true, enabled: true },
      { id: "gid://shopify/Market/9", name: "EU (draft)", handle: "eu", primary: false, enabled: false },
    ]);
    let report = await runSelfCheck("cellexia.myshopify.com");
    let check = checkOf(report, "widget_markets");
    expect(check?.status).toBe("FAIL");
    expect(check?.detail).toContain("hidden in EVERY market");
    expect(check?.remediation).toContain("Where the buy box shows");
    expect(report.verdict).toBe("BROKEN");

    // A saved market deleted in Shopify afterwards: same dark storefront.
    mocks.widgetMarketsSetting.value = { mode: "selected", handles: ["gone"] };
    mocks.widgetMarketsMetafield.value = JSON.stringify({ v: 1, mode: "selected", handles: ["gone"] });
    report = await runSelfCheck("cellexia.myshopify.com");
    check = checkOf(report, "widget_markets");
    expect(check?.status).toBe("FAIL");
    expect(check?.detail).toContain("“gone” is no longer a market");
  });

  it("widget_markets: an unreadable market list is a note on the PASS, never a verdict; the divergence FAIL still wins over the audit", async () => {
    mocks.widgetMarketsSetting.value = { mode: "selected", handles: ["ch"] };
    mocks.widgetMarketsMetafield.value = JSON.stringify({ v: 1, mode: "selected", handles: ["ch"] });
    mocks.listMarkets.mockRejectedValue(new Error("read_markets denied"));
    let report = await runSelfCheck("cellexia.myshopify.com");
    let check = checkOf(report, "widget_markets");
    expect(check?.status).toBe("PASS");
    expect(check?.detail).toContain("Could not verify the selected handles");
    expect(check?.detail).toContain("read_markets denied");

    // Diverged AND unverifiable → the divergence FAIL, unchanged wording.
    mocks.widgetMarketsMetafield.value = null;
    report = await runSelfCheck("cellexia.myshopify.com");
    check = checkOf(report, "widget_markets");
    expect(check?.status).toBe("FAIL");
    expect(check?.detail).toContain("(missing)");
  });

  it("widget_markets PASSes the default (all markets, metafield never written)", async () => {
    const report = await runSelfCheck("cellexia.myshopify.com");
    const check = checkOf(report, "widget_markets");
    expect(check?.status).toBe("PASS");
    expect(check?.detail).toContain("all markets");
    expect(check?.detail).toContain("absent");
  });

  it("widget_markets PASSes when the published value matches the selected list (order and duplicates ignored)", async () => {
    mocks.widgetMarketsSetting.value = { mode: "selected", handles: ["ch", "de"] };
    mocks.widgetMarketsMetafield.value = JSON.stringify({
      v: 1,
      mode: "selected",
      handles: ["de", "ch", "de"],
    });
    const report = await runSelfCheck("cellexia.myshopify.com");
    const check = checkOf(report, "widget_markets");
    expect(check?.status).toBe("PASS");
    expect(check?.detail).toContain("only 2 market(s): ch, de");
  });

  it("widget_markets FAILs when the storefront metafield disagrees with the setting, naming the re-sync fix", async () => {
    // Setting restricts, storefront never written (shows everywhere).
    mocks.widgetMarketsSetting.value = { mode: "selected", handles: ["ch"] };
    mocks.widgetMarketsMetafield.value = null;
    let report = await runSelfCheck("cellexia.myshopify.com");
    let check = checkOf(report, "widget_markets");
    expect(check?.status).toBe("FAIL");
    expect(check?.detail).toContain("(missing)");
    expect(check?.remediation).toContain("Where the buy box shows");
    expect(report.verdict).toBe("BROKEN");

    // Setting says all markets, storefront still restricts (a stale write).
    mocks.widgetMarketsSetting.value = { mode: "all", handles: [] };
    mocks.widgetMarketsMetafield.value = JSON.stringify({
      v: 1,
      mode: "selected",
      handles: ["ch"],
    });
    report = await runSelfCheck("cellexia.myshopify.com");
    check = checkOf(report, "widget_markets");
    expect(check?.status).toBe("FAIL");
    expect(check?.detail).toContain('"selected"');

    // Different lists.
    mocks.widgetMarketsSetting.value = { mode: "selected", handles: ["ch", "de"] };
    report = await runSelfCheck("cellexia.myshopify.com");
    expect(checkOf(report, "widget_markets")?.status).toBe("FAIL");

    // Unparsable JSON is drift too — a re-sync rewrites the canonical value.
    mocks.widgetMarketsMetafield.value = "{not json";
    report = await runSelfCheck("cellexia.myshopify.com");
    expect(checkOf(report, "widget_markets")?.status).toBe("FAIL");
  });

  it("widget_markets is in the Launch & storefront category, right beside launch_flag", async () => {
    const report = await runSelfCheck("cellexia.myshopify.com");
    const keys = report.checks.map((c) => c.key);
    expect(keys.indexOf("widget_markets")).toBe(keys.indexOf("launch_flag") + 1);
    expect(checkOf(report, "widget_markets")?.category).toBe("Launch & storefront");
  });

  it("renewal_readiness flags ACTIVE contracts with no next billing date", async () => {
    mocks.contractCount.mockImplementation(
      async (args?: { where?: { nextBillingDate?: unknown } }) =>
        args?.where && "nextBillingDate" in args.where &&
        args.where.nextBillingDate === null
          ? 3
          : 0,
    );

    const report = await runSelfCheck("cellexia.myshopify.com");
    const check = report.checks.find((c) => c.key === "renewal_readiness");
    expect(check?.status).toBe("FAIL"); // LIVE store
    expect(check?.detail).toContain("3 ACTIVE contract(s)");

    mocks.launchMode.value = "SETUP";
    const setupReport = await runSelfCheck("cellexia.myshopify.com");
    expect(
      setupReport.checks.find((c) => c.key === "renewal_readiness")?.status,
    ).toBe("WARN"); // fix before go-live, not an outage yet
  });

  it("dunning_config WARNs about ladder steps the exhaust cutoff makes unreachable", async () => {
    mocks.dunningSetting.value = {
      ...mocks.dunningSetting.value,
      softRetryDays: [0, 3, 45],
      emailLadderDays: [0, 35],
      smsDay: 31,
      cancelAfterFailedDays: 30,
    };

    const report = await runSelfCheck("cellexia.myshopify.com");
    const check = report.checks.find((c) => c.key === "dunning_config");
    expect(check?.status).toBe("WARN");
    expect(check?.detail).toContain("45");
    expect(check?.detail).toContain("35");
    expect(check?.detail).toContain("SMS day (31)");
  });

  it("job_locks FAILs on a lease no code path could have written", async () => {
    mocks.jobLockFindMany.mockResolvedValue([
      { name: "billing_run", lockedUntil: new Date(Date.now() + 7_200_000) },
    ]);

    const report = await runSelfCheck("cellexia.myshopify.com");
    const check = report.checks.find((c) => c.key === "job_locks");
    expect(check?.status).toBe("FAIL");
    expect(check?.detail).toContain("billing_run");
  });

  it("klaviyo_key_live grades a rejected key FAIL, an unreachable Klaviyo WARN, and no key SKIP", async () => {
    mocks.probeKlaviyoKey.mockResolvedValue({
      ok: false,
      detail: "Klaviyo rejected the key (401 unauthorized).",
    });
    let report = await runSelfCheck("cellexia.myshopify.com");
    expect(
      report.checks.find((c) => c.key === "klaviyo_key_live")?.status,
    ).toBe("FAIL");

    mocks.probeKlaviyoKey.mockResolvedValue({
      ok: false,
      transient: true,
      detail: "Could not reach Klaviyo to test the key — try again (timeout)",
    });
    report = await runSelfCheck("cellexia.myshopify.com");
    expect(
      report.checks.find((c) => c.key === "klaviyo_key_live")?.status,
    ).toBe("WARN");

    mocks.klaviyoConfigured.value = false;
    report = await runSelfCheck("cellexia.myshopify.com");
    expect(
      report.checks.find((c) => c.key === "klaviyo_key_live")?.status,
    ).toBe("SKIP");
  });

  it("klaviyo_flow_coverage reads the cached verdict: SKIP before setup, WARN on uncovered metrics", async () => {
    // Never set up → coverage untracked.
    let report = await runSelfCheck("cellexia.myshopify.com");
    expect(
      report.checks.find((c) => c.key === "klaviyo_flow_coverage")?.status,
    ).toBe("SKIP");

    mocks.flowSetupSetting.value = {
      checkedAt: new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
      setupRanAt: new Date().toISOString(),
      rows: [
        { metric: "Cellexia Payment failed", status: "missing" },
        { metric: "Cellexia Upcoming order", status: "live" },
      ],
    };
    report = await runSelfCheck("cellexia.myshopify.com");
    const check = report.checks.find((c) => c.key === "klaviyo_flow_coverage");
    expect(check?.status).toBe("WARN");
    expect(check?.detail).toContain("Cellexia Payment failed");

    mocks.flowSetupSetting.value.rows = [
      { metric: "Cellexia Payment failed", status: "live" },
    ];
    report = await runSelfCheck("cellexia.myshopify.com");
    expect(
      report.checks.find((c) => c.key === "klaviyo_flow_coverage")?.status,
    ).toBe("PASS");
  });

  it("klaviyo_flow_coverage WARNs on rate_limited / pending_metric rows (a run that stopped early) — never PASS 'all covered'; PASS counts only live/app_delivers/off", async () => {
    // A guided run that Klaviyo's Create Flow limit ended after 1 of 3 flows:
    // the leftover rows are rate_limited (not in UNCOVERED_STATUSES, so the
    // alert sweep waits for its daily re-verify) — the self-check must still
    // say so instead of "All 3 delivery metrics are covered".
    mocks.flowSetupSetting.value = {
      checkedAt: new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
      setupRanAt: new Date().toISOString(),
      rows: [
        { metric: "Cellexia Upcoming order", status: "live" },
        { metric: "Cellexia Payment failed", status: "rate_limited" },
        { metric: "Cellexia Order shipped", status: "rate_limited" },
      ],
    };
    let report = await runSelfCheck("cellexia.myshopify.com");
    let check = report.checks.find((c) => c.key === "klaviyo_flow_coverage");
    expect(check?.status).toBe("WARN");
    expect(check?.detail).toContain("2 metric(s) not covered yet");
    expect(check?.detail).toContain("Cellexia Payment failed");
    expect(check?.detail).toContain("Cellexia Order shipped");
    expect(check?.detail).toMatch(/Create my flows again/);

    // A seeded metric Klaviyo has not registered yet is not covered either.
    mocks.flowSetupSetting.value.rows = [
      { metric: "Cellexia Upcoming order", status: "live" },
      { metric: "Cellexia Gift Teaser", status: "pending_metric" },
    ];
    report = await runSelfCheck("cellexia.myshopify.com");
    check = report.checks.find((c) => c.key === "klaviyo_flow_coverage");
    expect(check?.status).toBe("WARN");
    expect(check?.detail).toContain("1 metric(s) not covered yet");
    expect(check?.detail).toContain("Cellexia Gift Teaser");

    // PASS detail counts only what is genuinely covered.
    mocks.flowSetupSetting.value.rows = [
      { metric: "Cellexia Upcoming order", status: "live" },
      { metric: "Cellexia Order shipped", status: "app_delivers" },
      { metric: "Cellexia Resume Reminder", status: "off" },
    ];
    report = await runSelfCheck("cellexia.myshopify.com");
    check = report.checks.find((c) => c.key === "klaviyo_flow_coverage");
    expect(check?.status).toBe("PASS");
    expect(check?.detail).toContain("All 3 delivery metrics are covered");
  });

  it("email_templates WARNs when a merchant override leaves a placeholder unresolved", async () => {
    mocks.emailsSetting.value = {
      templates: {
        upcoming_order: {
          enabled: true,
          subject: "Your order ships {next_datee}", // typo'd variable
          body: "",
          sender: "auto",
        },
      },
    };

    const report = await runSelfCheck("cellexia.myshopify.com");
    const check = report.checks.find((c) => c.key === "email_templates");
    expect(check?.status).toBe("WARN");
    expect(check?.detail).toContain("upcoming_order");
    expect(check?.detail).toContain("next_datee");
  });

  it("stored_secrets FAILs when an encrypted credential no longer decrypts", async () => {
    mocks.klaviyoSetting.value = {
      privateApiKey: "enc:v1:AAAA.BBBB.CCCC", // undecryptable blob
    };

    const report = await runSelfCheck("cellexia.myshopify.com");
    const check = report.checks.find((c) => c.key === "stored_secrets");
    expect(check?.status).toBe("FAIL");
    expect(check?.detail).toContain("Klaviyo");
  });

  it("event_provenance WARNs when contract-scoped events lost their contract", async () => {
    mocks.subscriberEventCount.mockResolvedValue(4);

    const report = await runSelfCheck("cellexia.myshopify.com");
    const check = report.checks.find((c) => c.key === "event_provenance");
    expect(check?.status).toBe("WARN");
    expect(check?.detail).toContain("4 contract-scoped event(s)");
  });
});

describe("selfcheck_run job registration", () => {
  it("is registered, every 30 minutes, and NOT setup-gated", () => {
    expect(JOB_NAMES).toContain("selfcheck_run");
    expect(SETUP_GATED_JOB_NAMES).not.toContain("selfcheck_run");
    const schedule = JOB_SCHEDULE.find((j) => j.name === "selfcheck_run");
    expect(schedule?.everyMinutes).toBe(30);
    expect(schedule?.gatedInSetup).toBe(false);
  });

  it("JOB_SCHEDULE mirrors JOB_NAMES in order", () => {
    expect(JOB_SCHEDULE.map((j) => j.name)).toEqual([...JOB_NAMES]);
  });
});
