import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ROUTE-LEVEL tests for GET /api/health — the mailer leg.
 *
 * verifyMailer() existed but had ZERO call sites: a production deploy without
 * MAIL_PROVIDER=smtp delivered no direct mail (OTP, 3DS, admin alerts) while
 * NotificationLog said SENT and /api/health stayed green — a totally silent
 * outage of portal email login. The loader now folds the mailer status into
 * overall health and surfaces it in the body, so an uptime monitor pages on
 * the forgot-MAIL_PROVIDER deploy exactly like on a stale billing_run.
 *
 * The DB and runner seams are vi.mock'ed (the config's documented pattern);
 * verifyMailer is mocked per test. The route caches the mailer status for a
 * TTL (uptime monitors probe fast; smtp verify is a real round-trip), so each
 * test loads a fresh module instance via resetModules.
 */

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(async (): Promise<unknown> => [1]),
  jobRunFindFirst: vi.fn(async (): Promise<unknown> => null),
  billingAttemptCount: vi.fn(async (): Promise<number> => 0),
  dunningCaseCount: vi.fn(async (): Promise<number> => 0),
  alertCount: vi.fn(async (): Promise<number> => 0),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({ id: "shop_1" })),
  verifyMailer: vi.fn(
    async (): Promise<unknown> => ({ ok: true, provider: "smtp" }),
  ),
}));

vi.mock("~/db.server", () => ({
  default: {
    $queryRaw: mocks.queryRaw,
    jobRun: { findFirst: mocks.jobRunFindFirst },
    billingAttempt: { count: mocks.billingAttemptCount },
    dunningCase: { count: mocks.dunningCaseCount },
    alert: { count: mocks.alertCount },
  },
}));
vi.mock("~/lib/jobs/runner.server", () => ({ JOB_NAMES: [] }));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: mocks.getPrimaryShop,
}));
vi.mock("~/lib/notifications/mailer.server", () => ({
  verifyMailer: mocks.verifyMailer,
}));

/** Fresh route module (fresh mailer-status cache) with the mocks re-applied. */
async function loadLoader() {
  vi.resetModules();
  const { loader } = await import("~/routes/api.health");
  return loader;
}

async function invoke(
  loader: (args: never) => Promise<Response>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await loader({
    request: new Request("https://cellexia.example/api/health"),
    params: {},
    context: {},
  } as never);
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queryRaw.mockResolvedValue([1]);
  mocks.jobRunFindFirst.mockResolvedValue(null); // billing never ran → healthy
  mocks.getPrimaryShop.mockResolvedValue({ id: "shop_1" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/health — mailer status", () => {
  it("stays 200 with the mailer status in the body when the mailer verifies", async () => {
    mocks.verifyMailer.mockResolvedValue({ ok: true, provider: "smtp" });
    const { status, body } = await invoke(await loadLoader());

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.mailer).toEqual({ ok: true, provider: "smtp" });
  });

  it("goes 503 when the mailer is unhealthy even while DB and billing are green", async () => {
    mocks.verifyMailer.mockResolvedValue({
      ok: false,
      provider: "console",
      implicitFallback: true,
      error: "MAIL_PROVIDER is not set",
    });
    const { status, body } = await invoke(await loadLoader());

    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.db).toBe(true); // proves the mailer alone flipped health
    expect(body.mailer).toMatchObject({
      ok: false,
      provider: "console",
      error: expect.stringContaining("MAIL_PROVIDER"),
    });
  });

  it("caches the mailer verification between probes (smtp verify is a real round-trip)", async () => {
    mocks.verifyMailer.mockResolvedValue({ ok: true, provider: "smtp" });
    const loader = await loadLoader();

    await invoke(loader);
    await invoke(loader);

    expect(mocks.verifyMailer).toHaveBeenCalledTimes(1);
  });

  it("an explicit console provider is healthy but visibly surfaced", async () => {
    mocks.verifyMailer.mockResolvedValue({ ok: true, provider: "console" });
    const { status, body } = await invoke(await loadLoader());

    expect(status).toBe(200);
    expect(body.mailer).toEqual({ ok: true, provider: "console" });
  });

  it("a mailer check that throws unexpectedly degrades to unhealthy, not to a crash", async () => {
    mocks.verifyMailer.mockRejectedValue(new Error("boom"));
    const { status, body } = await invoke(await loadLoader());

    expect(status).toBe(503);
    expect((body.mailer as { ok: boolean; error?: string }).ok).toBe(false);
    expect((body.mailer as { error?: string }).error).toContain("boom");
  });
});
