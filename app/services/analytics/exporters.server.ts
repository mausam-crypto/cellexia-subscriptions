/**
 * CSV export builders [analytics] — server-only module. Lives outside the
 * route file because Remix only strips `loader`/`action` exports: any other
 * route export referencing ~/db.server drags server code into the client
 * graph and breaks the build.
 */
/**
 * CSV export resource route [analytics] — serves the Export tab downloads
 * (?export=contracts|events|forecast|cohorts). This module deliberately has
 * no component: app.analytics.tsx renders a UI, so a Response returned from
 * its loader is unwrapped into route data and can never reach the browser as
 * a raw text/csv document. The Export tab fetches this route with the
 * App Bridge-authenticated `fetch` (Bearer session token → token exchange)
 * and saves the body as a file client-side.
 */
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { requireRole } from "~/services/core/rbac.server";
import { getCohortTable } from "~/services/analytics/metrics.server";
import {
  COHORT_DIMENSIONS,
  COHORT_METRICS,
} from "~/services/analytics/cohortTypes";
import type {
  CohortDimension,
  CohortMetric,
} from "~/services/analytics/cohortTypes";
import { parseForecastSnapshotRows } from "~/services/analytics/forecast.server";

export function pickParam<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  return (allowed as readonly string[]).includes(value ?? "")
    ? (value as T)
    : fallback;
}

/**
 * RFC-4180 escaping + spreadsheet formula-injection neutralisation.
 *
 * Excel/Sheets interpret cells beginning with `=`, `+`, `-` or `@` (and
 * leading tab/CR) as formulas — a crafted value like `=WEBSERVICE(...)` in a
 * customer-controlled field would execute when the merchant opens the export.
 * String cells starting with those characters are prefixed with an apostrophe
 * (the spreadsheet "treat as text" marker); numeric cells (e.g. negative
 * numbers) are left intact. Exported for unit tests.
 */
export function csvEscape(value: string | number | null | undefined): string {
  let s = value == null ? "" : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Exported for unit tests. */
export function toCsv(
  header: string[],
  rows: Array<Array<string | number | null | undefined>>,
): string {
  return (
    [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n") +
    "\n"
  );
}

function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

/** Exported for unit tests (mock ~/db.server). */
export async function buildExport(
  shop: string,
  kind: string,
  dimension: CohortDimension,
  metric: CohortMetric,
): Promise<Response> {
  if (kind === "contracts") {
    const contracts = await prisma.subscriptionContract.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
    });
    const csv = toCsv(
      [
        "id",
        "shopifyContractId",
        "status",
        "customerEmail",
        "createdAt",
        "intervalWeeks",
        "successfulOrders",
        "failedAttempts",
        "totalRevenueCents",
        "currencyCode",
        "qualityScore",
        "churnRiskScore",
        "expectedLtvCents",
        "cancelledAt",
        "cancelReason",
        "widgetVersion",
        "firstOrderAovCents",
        "initialDiscountPercent",
      ],
      contracts.map((c) => [
        c.id,
        c.shopifyContractId,
        c.status,
        c.customerEmail,
        c.createdAt.toISOString(),
        c.intervalWeeks,
        c.successfulOrders,
        c.failedAttempts,
        c.totalRevenueCents,
        c.currencyCode,
        c.qualityScore,
        c.churnRiskScore,
        c.expectedLtvCents,
        c.cancelledAt ? c.cancelledAt.toISOString() : null,
        c.cancelReason,
        c.widgetVersion,
        c.firstOrderAovCents,
        c.initialDiscountPercent,
      ]),
    );
    return csvResponse(csv, "cellexia-contracts.csv");
  }

  if (kind === "events") {
    const events = await prisma.analyticsEvent.findMany({
      where: { shop },
      orderBy: { occurredAt: "desc" },
      take: 10000,
    });
    const csv = toCsv(
      ["id", "name", "contractId", "shopifyCustomerId", "occurredAt", "payloadJson"],
      events.map((e) => [
        e.id,
        e.name,
        e.contractId,
        e.shopifyCustomerId,
        e.occurredAt.toISOString(),
        e.payloadJson,
      ]),
    );
    return csvResponse(csv, "cellexia-events.csv");
  }

  if (kind === "forecast") {
    const snapshot = await prisma.forecastSnapshot.findFirst({
      where: { shop },
      orderBy: { computedAt: "desc" },
    });
    // runForecastJob stores the V2 envelope {rows, meta}; older snapshots
    // are bare arrays. parseForecastSnapshotRows reads both — a raw
    // parseJson<ForecastRow[]> cast here made rows.map throw on every V2
    // envelope snapshot, 500ing the forecast export permanently after the
    // first post-deploy nightly job run.
    const { rows } = parseForecastSnapshotRows(snapshot?.rowsJson);
    const csv = toCsv(
      [
        "weekStart",
        "sku",
        "title",
        "market",
        "contractedUnits",
        "probabilityAdjustedUnits",
        "expectedSkips",
        "expectedPauses",
        "expectedCancellations",
        "expectedFailedPayments",
        "expectedAddOnUnits",
        "revenueCents",
        "marginCents",
        "ciLowCents",
        "ciHighCents",
      ],
      rows.map((r) => [
        r.weekStart,
        r.sku,
        r.title,
        r.market,
        r.contractedUnits,
        r.probabilityAdjustedUnits,
        r.expectedSkips,
        r.expectedPauses,
        r.expectedCancellations,
        r.expectedFailedPayments,
        r.expectedAddOnUnits,
        r.revenueCents,
        r.marginCents,
        r.ciLowCents,
        r.ciHighCents,
      ]),
    );
    return csvResponse(csv, "cellexia-forecast.csv");
  }

  // Default export: the currently-selected cohort table.
  const table = await getCohortTable(shop, dimension, metric);
  const csv = toCsv(
    ["cohort", "cohortSize", ...table.columns],
    table.rows.map((row) => [row.key, row.cohortSize, ...row.cells]),
  );
  return csvResponse(csv, `cellexia-cohorts-${dimension}-${metric}.csv`);
}

