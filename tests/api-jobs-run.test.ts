import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ROUTE-LEVEL tests for POST /api/jobs/run — the external cron trigger.
 *
 * This endpoint is the one unauthenticated HTTP surface that can start
 * BILLING. Everything else in the app sits behind Shopify OAuth or a signed
 * app-proxy request; this one is guarded by a single shared secret, so its
 * auth branch is the highest-consequence `if` in the route tree. If it ever
 * failed open, an anonymous POST could drive real charges against real cards.
 *
 * The suite therefore asserts the negative case the hardest: on EVERY rejected
 * request runAllDueJobs must not have been called at all. A 401 that still ran
 * the jobs would be indistinguishable from a 200 to the subscriber whose card
 * was charged, so status codes alone are not enough.
 *
 * The runner is vi.mock'ed (the config's documented pattern for DB-touching
 * seams): it statically pulls prisma and shopify.server, which need a live DB
 * and API credentials that the pure-logic suite deliberately does not have.
 */

// Typed with the real runner signature — (now: Date) => Promise<void> — so the
// "same instant" assertion below type-checks against the recorded call.
const runAllDueJobs = vi.hoisted(() =>
  vi.fn(async (_now: Date): Promise<void> => undefined),
);

vi.mock("~/lib/jobs/runner.server", () => ({
  runAllDueJobs,
  JOB_NAMES: [],
  SETUP_GATED_JOB_NAMES: [],
}));

const { action } = await import("~/routes/api.jobs.run");

const SECRET = "correct-horse-battery-staple";

/** A request shaped exactly like the cron caller's. */
function post(secret?: string, method = "POST"): Request {
  const headers = new Headers();
  if (secret !== undefined) headers.set("x-cron-secret", secret);
  return new Request("https://cellexia.example/api/jobs/run", {
    method,
    headers,
  });
}

/** Invoke the route the way Remix does. */
function invoke(request: Request) {
  return action({ request, params: {}, context: {} } as never) as Promise<
    Response
  >;
}

const ORIGINAL_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  runAllDueJobs.mockClear();
  process.env.CRON_SECRET = SECRET;
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_SECRET;
});

describe("POST /api/jobs/run — authorized", () => {
  it("runs the due jobs and reports the timestamp it used", async () => {
    const before = Date.now();
    const res = await invoke(post(SECRET));
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(runAllDueJobs).toHaveBeenCalledTimes(1);

    const body = (await res.json()) as { ok: boolean; ranAt: string };
    expect(body.ok).toBe(true);

    // ranAt is the SAME instant handed to the runner — the audit trail and the
    // due-check must agree, or a job could be marked run at a time it was not.
    const passed = runAllDueJobs.mock.calls[0][0];
    expect(passed).toBeInstanceOf(Date);
    expect(body.ranAt).toBe(passed.toISOString());

    const ranAt = new Date(body.ranAt).getTime();
    expect(ranAt).toBeGreaterThanOrEqual(before);
    expect(ranAt).toBeLessThanOrEqual(after);
  });

  it("is safe to call repeatedly — each call runs the due-check once", async () => {
    // The cron may fire far more often than any job's cadence; the runner's
    // own due-checking makes that free, so the route must not throttle or
    // dedupe (that would silently skip a billing window).
    await invoke(post(SECRET));
    await invoke(post(SECRET));
    await invoke(post(SECRET));
    expect(runAllDueJobs).toHaveBeenCalledTimes(3);
  });
});

describe("POST /api/jobs/run — rejected", () => {
  // Each case pairs a request with the reason it must not be trusted.
  const CASES: Array<{ name: string; secret?: string; env?: string | null }> = [
    { name: "no x-cron-secret header at all", secret: undefined },
    { name: "an empty secret", secret: "" },
    { name: "a wrong secret of the SAME length", secret: "x".repeat(SECRET.length) },
    { name: "a wrong secret of a different length", secret: "nope" },
    { name: "a secret that is a PREFIX of the real one", secret: SECRET.slice(0, -1) },
    { name: "the real secret plus a suffix", secret: `${SECRET}x` },
    { name: "a case-mismatched secret", secret: SECRET.toUpperCase() },
    // Fail closed: an unset/blank CRON_SECRET must never mean "no auth needed".
    { name: "the correct value while CRON_SECRET is unset", secret: SECRET, env: null },
    { name: "an empty secret while CRON_SECRET is unset", secret: "", env: null },
    { name: "any secret while CRON_SECRET is empty", secret: SECRET, env: "" },
  ];

  it.each(CASES)("401s on $name, without running any job", async ({ secret, env }) => {
    if (env === null) delete process.env.CRON_SECRET;
    else if (env !== undefined) process.env.CRON_SECRET = env;

    const res = await invoke(post(secret));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    // The assertion that actually matters: no billing was started.
    expect(runAllDueJobs).not.toHaveBeenCalled();
  });

  it.each(["GET", "PUT", "PATCH", "DELETE", "HEAD"])(
    "405s on %s even with the correct secret",
    async (method) => {
      const res = await invoke(post(SECRET, method));
      expect(res.status).toBe(405);
      expect(runAllDueJobs).not.toHaveBeenCalled();
    },
  );

  it("never leaks the expected secret in a rejection body", async () => {
    const res = await invoke(post("wrong"));
    expect(await res.text()).not.toContain(SECRET);
  });
});
