import { json } from "@remix-run/node";
import prisma from "~/db.server";
import { JOB_NAMES } from "~/lib/jobs/runner.server";
import { getPrimaryShop } from "~/lib/shop/install.server";

/**
 * Health / monitoring endpoint: GET /api/health.
 *
 * 200 when the database answers AND the billing_run job either succeeded in
 * the last 30 minutes or has never run (fresh install); 503 otherwise, so an
 * uptime monitor pages before subscribers miss a renewal. The body carries
 * the operational vitals a human checks first.
 */

const BILLING_FRESHNESS_MS = 30 * 60_000;

interface JobRunSummary {
  status: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export const loader = async () => {
  const now = new Date();

  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch (err) {
    console.error("[health] db ping failed", err);
  }

  const lastJobRuns: Record<string, JobRunSummary | null> = {};
  let pendingAttempts = 0;
  let openDunning = 0;
  let openAlerts = 0;
  let uninstalled = true;
  let billingOk = true;

  if (dbOk) {
    try {
      const latestRuns = await Promise.all(
        JOB_NAMES.map((name) =>
          prisma.jobRun.findFirst({
            where: { jobName: name },
            orderBy: { startedAt: "desc" },
            select: {
              status: true,
              startedAt: true,
              finishedAt: true,
              error: true,
            },
          }),
        ),
      );
      JOB_NAMES.forEach((name, i) => {
        const run = latestRuns[i];
        lastJobRuns[name] = run
          ? {
              status: run.status,
              startedAt: run.startedAt.toISOString(),
              finishedAt: run.finishedAt?.toISOString() ?? null,
              error: run.error,
            }
          : null;
      });

      const [pending, dunning, alerts, shop, billingEver, billingFresh] =
        await Promise.all([
          prisma.billingAttempt.count({ where: { status: "PENDING" } }),
          prisma.dunningCase.count({
            where: {
              state: { in: ["OPEN", "RETRYING", "AWAITING_CUSTOMER", "AWAITING_3DS"] },
            },
          }),
          prisma.alert.count({ where: { resolvedAt: null } }),
          getPrimaryShop(),
          prisma.jobRun.findFirst({
            where: { jobName: "billing_run" },
            select: { id: true },
          }),
          prisma.jobRun.findFirst({
            where: {
              jobName: "billing_run",
              status: "SUCCESS",
              startedAt: { gte: new Date(now.getTime() - BILLING_FRESHNESS_MS) },
            },
            select: { id: true },
          }),
        ]);

      pendingAttempts = pending;
      openDunning = dunning;
      openAlerts = alerts;
      uninstalled = shop === null;
      // Healthy when billing_run never ran (fresh install / first minutes) or
      // when it succeeded within the freshness window.
      billingOk = billingEver === null || billingFresh !== null;
    } catch (err) {
      console.error("[health] status queries failed", err);
      billingOk = false;
    }
  }

  const ok = dbOk && billingOk;

  return json(
    {
      ok,
      db: dbOk,
      now: now.toISOString(),
      lastJobRuns,
      pendingAttempts,
      openDunning,
      openAlerts,
      uninstalled,
    },
    { status: ok ? 200 : 503 },
  );
};
