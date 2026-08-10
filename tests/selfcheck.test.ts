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
      { name: "Default plan", syncStatus: "SYNCED", syncError: null },
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
    setSetting: vi.fn(async (): Promise<void> => {}),
    raiseAlert: vi.fn(async (): Promise<boolean> => true),
    logEvent: vi.fn(async (): Promise<void> => {}),
    probeProxyIdentity: vi.fn(async (): Promise<unknown> => ({
      status: "OK",
      url: "https://cellexialabs.com/apps/cellexia-subs/preview/validate",
      detail: null,
    })),
    launchMode: { value: "LIVE" as "LIVE" | "SETUP" },
    klaviyoConfigured: { value: true },
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
    if (key === "dunning") return { cancelAfterFailedDays: 30 };
    if (key === "selfCheck") return { version: 1, lastReport: null };
    return {};
  }),
  setSetting: mocks.setSetting,
}));

vi.mock("~/lib/graphql/metafields.server", () => ({
  getShopMetafield: vi.fn(async (): Promise<unknown> => ({
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
  })),
}));

vi.mock("~/lib/graphql/sellingPlans.server", () => ({
  getCurrentAppId: vi.fn(async (): Promise<string> => "4242"),
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
}));

vi.mock("~/lib/klaviyo/client.server", () => ({
  isKlaviyoConfigured: vi.fn((): boolean => mocks.klaviyoConfigured.value),
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

/** Storefront + portal fetches answer 200 with our portal marker. */
function stubHealthyFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        '<html><div class="cx-portal" data-cellexia-portal></div></html>',
        { status: 200 },
      ),
    ),
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
  mocks.planConfigFindMany.mockResolvedValue([
    { name: "Default plan", syncStatus: "SYNCED", syncError: null },
  ]);
  mocks.webhookReceiptFindFirst.mockResolvedValue({
    receivedAt: new Date(Date.now() - 3_600_000),
    topic: "ORDERS_CREATE",
  });
  mocks.contractCount.mockResolvedValue(0);
  mocks.billingAttemptCount.mockResolvedValue(0);
  mocks.alertUpdateMany.mockResolvedValue({ count: 1 });
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
