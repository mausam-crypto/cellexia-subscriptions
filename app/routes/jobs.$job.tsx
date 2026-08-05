/**
 * Scheduled-job runner [analytics route].
 *
 * POST /jobs/:job with `Authorization: Bearer $JOB_SECRET` dispatches to the
 * jobs registry (services/jobsRegistry.server.ts). Optional shop narrowing via
 * `?shop=<domain>` or a JSON body `{"shop": "<domain>"}`. GET returns 405.
 * Invoke from any scheduler (cron, Fly machines, GitHub Actions, ...) — see
 * docs/ANALYTICS.md.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { logger } from "~/lib/logger.server";
import { jobRegistry } from "~/services/jobsRegistry.server";

export const loader = async (_args: LoaderFunctionArgs) =>
  json(
    { ok: false, error: "Use POST with Authorization: Bearer $JOB_SECRET" },
    { status: 405, headers: { Allow: "POST" } },
  );

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json(
      { ok: false, error: "Method not allowed" },
      { status: 405, headers: { Allow: "POST" } },
    );
  }

  const secret = process.env.JOB_SECRET;
  const authorization = request.headers.get("authorization") ?? "";
  if (!secret || authorization !== `Bearer ${secret}`) {
    return json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const job = params.job ?? "";
  const runner = jobRegistry[job];
  if (!runner) {
    return json(
      { ok: false, error: `Unknown job "${job}"`, jobs: Object.keys(jobRegistry) },
      { status: 404 },
    );
  }

  const url = new URL(request.url);
  let shop = url.searchParams.get("shop") ?? undefined;
  const contentType = request.headers.get("content-type") ?? "";
  if (!shop && contentType.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as {
      shop?: string;
    } | null;
    if (body?.shop) shop = body.shop;
  }

  const startedAt = Date.now();
  try {
    const result = await runner(shop);
    const ms = Date.now() - startedAt;
    logger.info("job completed", { job, shop: shop ?? null, ms });
    return json({ ok: true, job, shop: shop ?? null, ms, result });
  } catch (error) {
    logger.error("job failed", {
      job,
      shop: shop ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    return json(
      {
        ok: false,
        job,
        shop: shop ?? null,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
};
