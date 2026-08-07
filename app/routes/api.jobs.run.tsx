import { timingSafeEqual } from "node:crypto";
import { json, type ActionFunctionArgs } from "@remix-run/node";
import { runAllDueJobs } from "~/lib/jobs/runner.server";

/**
 * External cron trigger: POST /api/jobs/run with header
 * `x-cron-secret: $CRON_SECRET`. Used when SCHEDULER_MODE=external replaces
 * the in-process 60s tick (bootstrap.server.ts). Due-checking and JobLock
 * leases live in the runner, so any cron frequency is safe.
 *
 * No loader — GET is not served.
 */

function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, { status: 405 });
  }

  const expected = process.env.CRON_SECRET;
  const provided = request.headers.get("x-cron-secret");
  // Fail closed when CRON_SECRET is unset — never an open trigger.
  if (!expected || !provided || !secretsMatch(provided, expected)) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  const ranAt = new Date();
  await runAllDueJobs(ranAt);

  return json({ ok: true, ranAt: ranAt.toISOString() });
};
