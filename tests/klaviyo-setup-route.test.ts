import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Klaviyo delivery setup page — loader/action contracts
 * (app/routes/app.emails_.setup.tsx, v1.25.0).
 *
 * Pinned here (the static shape pins live in tests/emails-routes.test.ts):
 *  - AUTO-VERIFY THROTTLE: the loader starts a background verify only when
 *    the cache's LAST TOUCH (checkedAt or lastAttemptAt — a failed attempt
 *    counts, so a broken key is not re-probed on every visit) is older than
 *    10 minutes, a key is connected, and no task is running. This is the
 *    ONLY guard against "verifies on every visit" — the root cause of the
 *    slow Emails area — so it must not silently regress to 0.
 *  - SAVE-KEY DURING A RUN: a running task keeps the OLD key (auth resolved
 *    at its start), so when startFlowTask refuses (already_running) the
 *    action must say so — `started:false`, the running task, and a toast
 *    telling the merchant the re-check happens when that run finishes
 *    (the page then submits one `refresh` automatically).
 *
 * Follows the tests/settings-secret-redaction.test.ts harness (route module
 * imported with its server seams mocked).
 */

const mocks = vi.hoisted(() => ({
  authenticateAdmin: vi.fn(async (): Promise<unknown> => ({
    session: { shop: "cellexia.myshopify.com" },
  })),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    contactEmail: "owner@example.com",
  })),
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "klaviyo") return { privateApiKey: "" };
    if (key === "alerts") return { emailTo: ["alerts@example.com"] };
    return {};
  }),
  setSetting: vi.fn(async (): Promise<void> => {}),
  logEvent: vi.fn(async (): Promise<void> => {}),
  isKlaviyoConfigured: vi.fn(async (): Promise<boolean> => true),
  probeKlaviyoKey: vi.fn(async (): Promise<unknown> => ({ ok: true, detail: "ok" })),
  resolveKlaviyoAuth: vi.fn(async (): Promise<unknown> => ({
    apiKey: "pk_x",
    revision: "2024-10-15",
    source: "settings",
  })),
  cached: {
    checkedAt: null as string | null,
    lastAttemptAt: null as string | null,
    setupRanAt: null as string | null,
    rows: [] as unknown[],
    task: null as unknown,
  },
  currentTask: null as unknown,
  getFlowTask: vi.fn(async (): Promise<unknown> => mocks.currentTask),
  startFlowTask: vi.fn(async (): Promise<unknown> => ({
    started: true,
    task: runningTask("new-task"),
  })),
}));

function runningTask(id: string) {
  const now = new Date().toISOString();
  return {
    id,
    kind: "verify",
    state: "running",
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    step: "reading",
    message: "Reading your Klaviyo metrics and flows…",
    done: 0,
    total: 0,
    report: null,
    error: null,
  };
}

vi.mock("~/shopify.server", () => ({
  authenticate: { admin: mocks.authenticateAdmin },
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: mocks.getPrimaryShop,
}));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: mocks.getSetting,
  setSetting: mocks.setSetting,
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/crypto/secrets.server", () => ({
  encryptSecret: (v: string) => `enc:v1:${v}`,
}));
vi.mock("~/lib/klaviyo/client.server", () => ({
  isKlaviyoConfigured: mocks.isKlaviyoConfigured,
  probeKlaviyoKey: mocks.probeKlaviyoKey,
  resolveKlaviyoAuth: mocks.resolveKlaviyoAuth,
}));
vi.mock("~/lib/klaviyo/flows.server", () => ({
  EXCLUDED_FROM_SETUP: [],
  readCachedCoverage: vi.fn(async () => mocks.cached),
}));
vi.mock("~/lib/klaviyo/setup-task.server", () => ({
  cachedCoverageRows: vi.fn(async () => []),
  getFlowTask: mocks.getFlowTask,
  startFlowTask: mocks.startFlowTask,
}));

const { action, loader } = await import("~/routes/app.emails_.setup");

function invokeLoader() {
  const request = new Request("https://cellexia.example/app/emails/setup");
  return loader({ request, params: {}, context: {} } as never) as Promise<Response>;
}

function invokeAction(fields: Record<string, string>) {
  const request = new Request("https://cellexia.example/app/emails/setup", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  return action({ request, params: {}, context: {} } as never) as Promise<Response>;
}

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cached = { checkedAt: null, lastAttemptAt: null, setupRanAt: null, rows: [], task: null };
  mocks.currentTask = null;
  mocks.isKlaviyoConfigured.mockResolvedValue(true);
  mocks.startFlowTask.mockResolvedValue({ started: true, task: runningTask("new-task") });
});

describe("loader auto-verify throttle", () => {
  it("fresh cache (checked 5 min ago) → no verify started", async () => {
    mocks.cached.checkedAt = minutesAgo(5);
    const res = await invokeLoader();
    expect(res.status).toBe(200);
    expect(mocks.startFlowTask).not.toHaveBeenCalled();
  });

  it("stale checkedAt but a FAILED attempt 3 min ago → no verify (a broken key is not re-probed on every visit)", async () => {
    mocks.cached.checkedAt = minutesAgo(120);
    mocks.cached.lastAttemptAt = minutesAgo(3);
    await invokeLoader();
    expect(mocks.startFlowTask).not.toHaveBeenCalled();
  });

  it("stale (11 min) or never-touched cache with a connected key → ONE background verify, and the loader renders the started task", async () => {
    mocks.cached.checkedAt = minutesAgo(11);
    mocks.cached.lastAttemptAt = minutesAgo(11);
    let res = await invokeLoader();
    expect(mocks.startFlowTask).toHaveBeenCalledTimes(1);
    expect(mocks.startFlowTask).toHaveBeenCalledWith("shop_1", "verify", expect.objectContaining({ actor: expect.any(String) }));
    let data = (await res.json()) as { task: { id: string } | null };
    expect(data.task?.id).toBe("new-task");

    mocks.startFlowTask.mockClear();
    mocks.cached = { checkedAt: null, lastAttemptAt: null, setupRanAt: null, rows: [], task: null };
    res = await invokeLoader();
    expect(mocks.startFlowTask).toHaveBeenCalledTimes(1);
    data = (await res.json()) as { task: { id: string } | null };
    expect(data.task?.id).toBe("new-task");
  });

  it("a running task → no new verify regardless of age; no key → never", async () => {
    mocks.cached.checkedAt = minutesAgo(600);
    mocks.currentTask = runningTask("elsewhere");
    let res = await invokeLoader();
    expect(mocks.startFlowTask).not.toHaveBeenCalled();
    const data = (await res.json()) as { task: { id: string } | null };
    expect(data.task?.id).toBe("elsewhere");

    mocks.currentTask = null;
    mocks.isKlaviyoConfigured.mockResolvedValue(false);
    res = await invokeLoader();
    expect(mocks.startFlowTask).not.toHaveBeenCalled();
  });

  it("the loader itself never touches Klaviyo — a failing start is contained (page still renders)", async () => {
    mocks.startFlowTask.mockRejectedValueOnce(new Error("db down"));
    const res = await invokeLoader();
    expect(res.status).toBe(200);
    const data = (await res.json()) as { task: unknown };
    expect(data.task).toBeNull();
  });
});

describe("save-key while a run is in flight", () => {
  it("stores the key, then reports started:false + the running task + a toast promising the re-check when the run finishes", async () => {
    mocks.startFlowTask.mockResolvedValue({
      started: false,
      reason: "already_running",
      task: runningTask("v1"),
    });
    const res = await invokeAction({ intent: "save-key", key: "pk_newkey" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      intent: string;
      ok: boolean;
      started: boolean;
      task: { id: string; state: string } | undefined;
      toast: string;
    };
    expect(mocks.probeKlaviyoKey).toHaveBeenCalledWith("pk_newkey");
    expect(mocks.setSetting).toHaveBeenCalledWith(
      "shop_1",
      "klaviyo",
      expect.objectContaining({ privateApiKey: "enc:v1:pk_newkey" }),
      expect.any(String),
    );
    expect(data.ok).toBe(true);
    expect(data.started).toBe(false);
    expect(data.task?.id).toBe("v1");
    expect(data.task?.state).toBe("running");
    expect(data.toast).toMatch(/re-checks with the new key as soon as the current run finishes/);
  });

  it("with nothing running the verify starts right away and the toast is the plain 'saved' one", async () => {
    const res = await invokeAction({ intent: "save-key", key: "pk_newkey" });
    const data = (await res.json()) as { started: boolean; task: { id: string }; toast: string };
    expect(data.started).toBe(true);
    expect(data.task.id).toBe("new-task");
    expect(data.toast).toBe("Klaviyo key saved — it applies within a minute");
  });

  it("a key Klaviyo rejects is never stored and no verify is started", async () => {
    mocks.probeKlaviyoKey.mockResolvedValueOnce({ ok: false, detail: "Klaviyo rejected the key (401)" });
    const res = await invokeAction({ intent: "save-key", key: "pk_bad" });
    expect(res.status).toBe(422);
    expect(mocks.setSetting).not.toHaveBeenCalled();
    expect(mocks.startFlowTask).not.toHaveBeenCalled();
  });
});
