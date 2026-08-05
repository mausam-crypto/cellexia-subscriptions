/**
 * CSV export resource route [analytics] — GET /app/analytics/export?export=…
 * All building logic lives in services/analytics/exporters.server.ts.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { requireRole } from "~/services/core/rbac.server";
import {
  COHORT_DIMENSIONS,
  COHORT_METRICS,
} from "~/services/analytics/cohortTypes";
import type {
  CohortDimension,
  CohortMetric,
} from "~/services/analytics/cohortTypes";
import {
  buildExport,
  pickParam,
} from "~/services/analytics/exporters.server";
export const loader = async ({
  request,
}: LoaderFunctionArgs): Promise<Response> => {
  const { session } = await authenticate.admin(request);
  // RBAC (SAFEGUARDS.md §5): resource routes are fetched directly, so the
  // layout loader can never cover them — every export of subscriber PII must
  // enforce its own role gate. CS_AGENT (and role-less staff once roles
  // exist) must not be able to bulk-download emails and revenue.
  await requireRole(session, "OWNER", "ADMIN", "ANALYST");
  const shop = session.shop;

  const url = new URL(request.url);
  const dimension = pickParam<CohortDimension>(
    url.searchParams.get("dimension"),
    COHORT_DIMENSIONS,
    "startMonth",
  );
  const metric = pickParam<CohortMetric>(
    url.searchParams.get("metric"),
    COHORT_METRICS,
    "retention",
  );
  const kind = url.searchParams.get("export") ?? "cohorts";

  return buildExport(shop, kind, dimension, metric);
};
