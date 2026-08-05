/**
 * Analytics workspace [analytics] — Cohorts (dimension x metric heat table
 * with calendar-month reading aids), Survival (curves + table with at-risk
 * counts), Forecast V2 (live computeForecast with model/scenario/horizon
 * links and a reliability grade), Costs (cost model + per-product COGS +
 * live LTGP example), Best configurations (highest 12-month contribution
 * combos) and Export (CSV downloads fetched from the app.analytics.export
 * resource route and saved client-side).
 *
 * Money is integer cents everywhere; the UI edits euros/percent and converts
 * on save (settingsJson.costModel stores cents + percents 0-100 per
 * docs/ANALYTICS-V2.md section 1; ProductMeta.grossMarginPercent stores a
 * FRACTION 0..1 and is displayed as a percent).
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useState } from "react";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
  useSubmit,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  DataTable,
  Divider,
  FormLayout,
  InlineStack,
  Layout,
  List,
  Page,
  Select,
  Tabs,
  Text,
  TextField,
} from "@shopify/polaris";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { toCents } from "~/lib/money";
import { addWeeks, isoDate, startOfWeek } from "~/lib/dates";
import { parseJson } from "~/types/domain";
import { appendAudit } from "~/services/audit.server";
import {
  requireRole,
  staffEmailFromSession,
} from "~/services/core/rbac.server";
import {
  getCohortTable,
  getSurvivalCurves,
} from "~/services/analytics/metrics.server";
import type {
  CohortTable,
  SurvivalCurve,
} from "~/services/analytics/metrics.server";
import { bestConfigurations } from "~/services/analytics/cohorts.server";
import type { BestConfiguration } from "~/services/analytics/cohorts.server";
import {
  COHORT_DIMENSIONS,
  COHORT_METRICS,
} from "~/services/analytics/cohortTypes";
import type {
  CohortDimension,
  CohortMetric,
} from "~/services/analytics/cohortTypes";
import type { SurvivalCohortBy } from "~/services/analytics/survival.server";
import { computeForecast } from "~/services/analytics/forecast.server";
import type {
  ForecastOptions,
  ForecastRow,
  Reliability,
} from "~/services/analytics/forecast.server";
import {
  getCostModel,
  metaByProductId,
  orderContribution,
} from "~/services/analytics/costModel.server";
import type { OrderContribution } from "~/services/analytics/costModel.server";
import { fmtDateLabel, fmtMoney, fmtPct } from "~/components/charts/format";
import { SurvivalChart } from "~/components/charts/SurvivalChart";
import { Sparkline } from "~/components/charts/Sparkline";
import { LineChart, CHART_MUTED } from "~/components/charts/LineChart";

// ── Constants ────────────────────────────────────────────────────────────

const TAB_IDS = [
  "cohorts",
  "survival",
  "forecast",
  "costs",
  "best",
  "export",
] as const;
type TabId = (typeof TAB_IDS)[number];

const SURVIVAL_COHORT_OPTIONS = [
  "all",
  "startMonth",
  "widgetVersion",
  "intervalWeeks",
] as const;

const FORECAST_MODELS = ["CONTRACT", "SURVIVAL_TREND"] as const;
const FORECAST_SCENARIOS = ["BASE", "CONSERVATIVE", "OPTIMISTIC"] as const;
const FORECAST_HORIZON_PARAMS = ["4", "13", "26"] as const;
const HORIZON_WEEKS: Record<
  (typeof FORECAST_HORIZON_PARAMS)[number],
  4 | 13 | 26
> = { "4": 4, "13": 13, "26": 26 };

const MAX_DETAIL_ROWS = 300;
const MAX_SURVIVAL_CURVES = 8;
/** Cohorts / checkpoints resting on fewer members than this are muted. */
const THIN_COHORT_SIZE = 5;

interface OpsRow {
  sku: string;
  title: string;
  weekly: number[];
  totalExpectedUnits: number;
  totalContractedUnits: number;
}

interface CostProductRow {
  id: string;
  title: string;
  unitCostCents: number | null;
  /** FRACTION 0..1 as stored on ProductMeta; displayed as a percent. */
  grossMarginPercent: number | null;
}

interface CostsData {
  configured: boolean;
  /** Percent 0-100 for display (stored fraction is normalised by getCostModel). */
  defaultGrossMarginPercent: number;
  shippingPerDeliveryCents: number;
  fulfillmentPerDeliveryCents: number;
  /** Percent 0-100 for display. */
  paymentFeePercent: number;
  paymentFeeFixedCents: number;
  products: CostProductRow[];
  example: {
    source: string;
    lines: Array<{ title: string; quantity: number; priceCents: number }>;
    breakdown: OrderContribution;
  };
}

interface ForecastData {
  computedAt: string | null;
  options: ForecastOptions;
  reliability: Reliability | null;
  weekLabels: string[];
  weeklyRevenueCents: number[];
  detailRows: ForecastRow[];
  totalRows: number;
  ops: OpsRow[];
}

interface AnalyticsLoaderData {
  tab: TabId;
  dimension: CohortDimension;
  metric: CohortMetric;
  cohortBy: string;
  currencyCode: string;
  cohortTable: CohortTable;
  survivalCurves: SurvivalCurve[];
  /** Total cohort curves available before the display cap (excludes "all"). */
  survivalTotalCohorts: number;
  bestConfigs: BestConfiguration[];
  costs: CostsData;
  forecast: ForecastData;
  /**
   * OWNER/ADMIN edit the cost model; ANALYST is read-only — the Costs tab
   * must not render save controls whose action would throw a 403 into the
   * ErrorBoundary.
   */
  canEditCosts: boolean;
}

// ── Pure helpers (exported for unit tests) ───────────────────────────────

function pickParam<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  return (allowed as readonly string[]).includes(value ?? "")
    ? (value as T)
    : fallback;
}

/**
 * PURE — choose which survival curves to display. The service returns the
 * "all" curve first, then one curve per cohort. The display cap must keep the
 * NEWEST start-month cohorts (the ones a merchant compares a recent change
 * against), not whichever end of the sort order happens to come first —
 * before this fix, `curves.slice(0, max + 1)` silently dropped every cohort
 * after the 8th, i.e. the most recent months. Order-independent: works
 * whether the service sorts cohort keys ascending or descending.
 */
export function pickSurvivalCurvesForDisplay(
  curves: SurvivalCurve[],
  cohortBy: string,
  max: number,
): { shown: SurvivalCurve[]; totalCohorts: number } {
  if (curves.length === 0) return { shown: [], totalCohorts: 0 };
  const [all, ...cohorts] = curves;
  let ordered = cohorts;
  if (cohortBy === "startMonth") {
    // "YYYY-MM" keys — lexicographic order is chronological. Newest first.
    ordered = [...cohorts].sort((a, b) => b.cohort.localeCompare(a.cohort));
  }
  return {
    shown: [all, ...ordered.slice(0, max)],
    totalCohorts: cohorts.length,
  };
}

/**
 * PURE — calendar month for a start-month cohort key at a month offset,
 * UTC-pinned so labels never drift by timezone. Returns null when the key is
 * not a "YYYY-MM" calendar month (other dimensions).
 */
export function calendarMonthLabel(
  cohortKey: string,
  offset: number,
): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(cohortKey);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return new Intl.DateTimeFormat("en-GB", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** PURE — column header text: M0 is each cohort's own calendar month. */
export function monthColumnLabel(label: string, index: number): string {
  return index === 0 ? `${label} · cohort month` : label;
}

/** PURE — a null cohort cell renders as "—", never 0. */
export function formatCohortValue(
  metric: CohortMetric,
  value: number | null,
  currencyCode: string,
): string {
  if (value == null) return "—";
  if (metric === "retention") return fmtPct(value, 0);
  if (metric === "subscribers") return String(value);
  return fmtMoney(value, currencyCode);
}

/** PURE — hover title for a cohort heat cell: exact value + cohort key. */
export function cohortCellTitle(
  metric: CohortMetric,
  rowKey: string,
  columnIndex: number,
  value: number | null,
  currencyCode: string,
): string {
  const cal = calendarMonthLabel(rowKey, columnIndex);
  const where = `M${columnIndex}${cal ? ` (${cal})` : ""}`;
  if (value == null) {
    return `${rowKey} · ${where}: no data — cohort too young to be observed here`;
  }
  if (metric === "retention") {
    return `${rowKey} · ${where}: ${fmtPct(value, 1)} still active`;
  }
  if (metric === "subscribers") {
    return `${rowKey} · ${where}: ${value} plans still active`;
  }
  return `${rowKey} · ${where}: ${fmtMoney(value, currencyCode)}`;
}

function heatBackground(value: number | null, max: number): string {
  if (value == null || max <= 0) return "transparent";
  const alpha = 0.12 + 0.78 * Math.min(1, Math.max(0, value / max));
  return `rgba(177, 205, 237, ${alpha.toFixed(2)})`;
}

/** PURE — Polaris badge tone for a forecast reliability grade. */
export function gradeTone(
  grade: Reliability["grade"],
): "critical" | "attention" | "success" {
  if (grade === "HIGH") return "success";
  if (grade === "MODERATE") return "attention";
  return "critical";
}

/**
 * PURE — parse a euros input ("12.50" or "12,50") into integer cents.
 * Empty string means "clear the value" (ok, cents null); malformed or
 * negative input is rejected.
 */
export function parseEurosToCents(raw: string): {
  ok: boolean;
  cents: number | null;
} {
  const s = raw.trim().replace(",", ".");
  if (s === "") return { ok: true, cents: null };
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, cents: null };
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return { ok: false, cents: null };
  return { ok: true, cents: toCents(n) };
}

/**
 * PURE — parse a percent input into a number 0..100 (decimals allowed,
 * e.g. "1.9"). Empty string means "clear the value"; out-of-range or
 * malformed input is rejected. NEVER silently treats 72 as a fraction.
 */
export function parsePercent(raw: string): {
  ok: boolean;
  percent: number | null;
} {
  const s = raw.trim().replace(",", ".");
  if (s === "") return { ok: true, percent: null };
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, percent: null };
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n) || n > 100) return { ok: false, percent: null };
  return { ok: true, percent: n };
}

// ── Loader ───────────────────────────────────────────────────────────────

export const loader = async ({
  request,
}: LoaderFunctionArgs): Promise<Response> => {
  const { session } = await authenticate.admin(request);
  // RBAC (SAFEGUARDS.md §5): Remix runs parent loaders in parallel with
  // child loaders, so app.tsx cannot gate this route — every admin loader
  // enforces its own roles. ANALYST is read-only analytics; CS_AGENT is not.
  // The role travels to the UI so the Costs tab hides edit controls that
  // ANALYST's submits could never save. (The first-run seed reports OWNER.)
  const { role } = await requireRole(session, "OWNER", "ADMIN", "ANALYST");
  const canEditCosts = role === "OWNER" || role === "ADMIN";
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
  const cohortBy = pickParam(
    url.searchParams.get("cohortBy"),
    SURVIVAL_COHORT_OPTIONS,
    "all",
  );
  const tab = pickParam<TabId>(url.searchParams.get("tab"), TAB_IDS, "cohorts");
  const model = pickParam(
    url.searchParams.get("model"),
    FORECAST_MODELS,
    "CONTRACT",
  );
  const scenario = pickParam(
    url.searchParams.get("scenario"),
    FORECAST_SCENARIOS,
    "BASE",
  );
  const horizonParam = pickParam(
    url.searchParams.get("horizon"),
    FORECAST_HORIZON_PARAMS,
    "13",
  );
  const options: ForecastOptions = {
    model,
    scenario,
    horizonWeeks: HORIZON_WEEKS[horizonParam],
  };

  const [
    settings,
    costModel,
    cohortTable,
    allSurvivalCurves,
    bestConfigs,
    productMetas,
    sampleContract,
  ] = await Promise.all([
    prisma.shopSettings.findUnique({ where: { shop } }),
    getCostModel(shop),
    getCohortTable(shop, dimension, metric),
    getSurvivalCurves(
      shop,
      cohortBy === "all" ? undefined : (cohortBy as SurvivalCohortBy),
    ),
    bestConfigurations(shop),
    prisma.productMeta.findMany({
      where: { shop },
      orderBy: { title: "asc" },
    }),
    prisma.subscriptionContract.findFirst({
      where: { shop, status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
      include: { lines: true },
    }),
  ]);

  const currencyCode = settings?.currencyCode ?? "EUR";

  // Survival: keep the NEWEST cohorts under the display cap, not the oldest.
  const { shown: survivalCurves, totalCohorts: survivalTotalCohorts } =
    pickSurvivalCurvesForDisplay(
      allSurvivalCurves,
      cohortBy,
      MAX_SURVIVAL_CURVES,
    );

  // Costs tab: live LTGP example through the cost engine — a real recent
  // plan when one exists, a representative sample order otherwise.
  let exampleLines: CostsData["example"]["lines"];
  let exampleSource: string;
  let exampleBreakdown: OrderContribution;
  if (sampleContract && sampleContract.lines.length > 0) {
    const metaMap = await metaByProductId(
      shop,
      sampleContract.lines.map((l) => l.shopifyProductId),
    );
    exampleLines = sampleContract.lines.map((l) => ({
      title: l.title,
      quantity: l.quantity,
      priceCents: l.currentPriceCents,
    }));
    exampleSource = "your most recent active treatment plan";
    exampleBreakdown = orderContribution(
      {
        lines: sampleContract.lines.map((l) => ({
          priceCents: l.currentPriceCents,
          quantity: l.quantity,
          meta: metaMap.get(l.shopifyProductId) ?? null,
        })),
      },
      costModel,
    );
  } else {
    exampleLines = [{ title: "Sample treatment", quantity: 1, priceCents: 4900 }];
    exampleSource = "a sample order (no active plans yet)";
    exampleBreakdown = orderContribution(
      { lines: [{ priceCents: 4900, quantity: 1, meta: null }] },
      costModel,
    );
  }

  const costs: CostsData = {
    configured: costModel.configured,
    defaultGrossMarginPercent:
      Math.round(costModel.defaultMarginFraction * 10000) / 100,
    shippingPerDeliveryCents: costModel.shippingPerDeliveryCents,
    fulfillmentPerDeliveryCents: costModel.fulfillmentPerDeliveryCents,
    paymentFeePercent: Math.round(costModel.paymentFeeFraction * 10000) / 100,
    paymentFeeFixedCents: costModel.paymentFeeFixedCents,
    products: productMetas.map((m) => ({
      id: m.id,
      title: m.title,
      unitCostCents: m.unitCostCents,
      grossMarginPercent: m.grossMarginPercent,
    })),
    example: {
      source: exampleSource,
      lines: exampleLines,
      breakdown: exampleBreakdown,
    },
  };

  // Forecast V2: computed live for the selected options, only when the
  // forecast tab is open (the tab is part of the URL, so switching tabs
  // re-runs the loader).
  let forecast: ForecastData = {
    computedAt: null,
    options,
    reliability: null,
    weekLabels: [],
    weeklyRevenueCents: [],
    detailRows: [],
    totalRows: 0,
    ops: [],
  };
  if (tab === "forecast") {
    const result = await computeForecast(shop, options);
    const rows = result.rows;
    const meta = result.meta;

    // Seed EVERY week of the horizon so zero-billing weeks stay visible
    // instead of compressing the timeline. week0 derives from the engine's
    // own computedAt so the seeded labels always match the row buckets.
    const week0 = startOfWeek(new Date(meta.computedAt));
    const weekLabels = Array.from({ length: options.horizonWeeks }, (_, i) =>
      isoDate(addWeeks(week0, i)),
    );
    const weekIndex = new Map(weekLabels.map((w, i) => [w, i]));
    const weeklyRevenueCents = new Array<number>(weekLabels.length).fill(0);

    const opsMap = new Map<string, OpsRow>();
    for (const row of rows) {
      const wi = weekIndex.get(row.weekStart);
      if (wi == null) continue;
      weeklyRevenueCents[wi] += row.revenueCents;
      let ops = opsMap.get(row.sku);
      if (!ops) {
        ops = {
          sku: row.sku,
          title: row.title,
          weekly: new Array<number>(weekLabels.length).fill(0),
          totalExpectedUnits: 0,
          totalContractedUnits: 0,
        };
        opsMap.set(row.sku, ops);
      }
      const expected = row.probabilityAdjustedUnits + row.expectedAddOnUnits;
      ops.weekly[wi] += expected;
      ops.totalExpectedUnits += expected;
      ops.totalContractedUnits += row.contractedUnits;
    }
    const opsRows = [...opsMap.values()]
      .map((o) => ({
        ...o,
        weekly: o.weekly.map((v) => Math.round(v * 10) / 10),
        totalExpectedUnits: Math.ceil(o.totalExpectedUnits),
      }))
      .sort((a, b) => b.totalExpectedUnits - a.totalExpectedUnits);

    forecast = {
      computedAt: meta.computedAt,
      options: meta.options,
      reliability: meta.reliability,
      weekLabels,
      weeklyRevenueCents,
      detailRows: rows.slice(0, MAX_DETAIL_ROWS),
      totalRows: rows.length,
      ops: opsRows,
    };
  }

  const data: AnalyticsLoaderData = {
    tab,
    dimension,
    metric,
    cohortBy,
    currencyCode,
    cohortTable,
    survivalCurves,
    survivalTotalCohorts,
    bestConfigs,
    costs,
    forecast,
    canEditCosts,
  };
  return json(data);
};

// ── Action (Costs tab — OWNER/ADMIN only, audited) ───────────────────────

interface CostActionResult {
  ok: boolean;
  message: string;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  // Authenticate against the analytics roles, then degrade a read-only
  // (ANALYST) submit into a banner-level error: a thrown 403 Response would
  // route to the app.tsx ErrorBoundary and replace the whole page. The UI
  // hides the save controls for read-only roles, so this only fires on
  // forged or stale submits — server-side enforcement stays intact.
  const { role } = await requireRole(session, "OWNER", "ADMIN", "ANALYST");
  if (role !== "OWNER" && role !== "ADMIN") {
    return json<CostActionResult>(
      { ok: false, message: "Your role cannot edit costs." },
      { status: 403 },
    );
  }
  const shop = session.shop;
  const actorId = staffEmailFromSession(session) ?? shop;

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const field = (name: string): string => String(formData.get(name) ?? "");

  if (intent === "save-cost-model") {
    const margin = parsePercent(field("defaultGrossMarginPercent"));
    const shipping = parseEurosToCents(field("shippingPerDelivery"));
    const fulfillment = parseEurosToCents(field("fulfillmentPerDelivery"));
    const feePercent = parsePercent(field("paymentFeePercent"));
    const feeFixed = parseEurosToCents(field("paymentFeeFixed"));
    if (
      !margin.ok ||
      margin.percent == null ||
      !shipping.ok ||
      shipping.cents == null ||
      !fulfillment.ok ||
      fulfillment.cents == null ||
      !feePercent.ok ||
      feePercent.percent == null ||
      !feeFixed.ok ||
      feeFixed.cents == null
    ) {
      return json<CostActionResult>(
        {
          ok: false,
          message:
            "Check the cost fields: amounts must be euros of 0 or more (e.g. 4.50), percentages between 0 and 100 (e.g. 1.9).",
        },
        { status: 400 },
      );
    }

    // Storage shape per docs/ANALYTICS-V2.md section 1: integer cents and
    // percents 0-100 as named; getCostModel normalises to fractions on read.
    const costModel = {
      defaultGrossMarginPercent: margin.percent,
      shippingPerDeliveryCents: shipping.cents,
      fulfillmentPerDeliveryCents: fulfillment.cents,
      paymentFeePercent: feePercent.percent,
      paymentFeeFixedCents: feeFixed.cents,
    };

    // Merge over existing settingsJson so keys owned by other modules
    // survive (same pattern as the Settings General tab).
    const existing = await prisma.shopSettings.findUnique({ where: { shop } });
    const parsed = parseJson<Record<string, unknown>>(
      existing?.settingsJson ?? "{}",
      {},
    );
    const existingCostModel =
      typeof parsed.costModel === "object" &&
      parsed.costModel !== null &&
      !Array.isArray(parsed.costModel)
        ? (parsed.costModel as Record<string, unknown>)
        : {};
    const merged = {
      ...parsed,
      costModel: { ...existingCostModel, ...costModel },
    };
    const settingsJson = JSON.stringify(merged);
    await prisma.shopSettings.upsert({
      where: { shop },
      update: { settingsJson },
      create: { shop, settingsJson },
    });
    await appendAudit({
      shop,
      actorType: "STAFF",
      actorId,
      action: "settings.cost_model_updated",
      subjectType: "ShopSettings",
      subjectId: shop,
      payload: costModel,
    });
    return json<CostActionResult>({
      ok: true,
      message: "Cost model saved — profit metrics now use your real costs.",
    });
  }

  if (intent === "save-product-cost") {
    const productId = field("productId");
    const meta = await prisma.productMeta.findFirst({
      where: { id: productId, shop },
    });
    if (!meta) {
      return json<CostActionResult>(
        { ok: false, message: "Product not found." },
        { status: 404 },
      );
    }
    const cost = parseEurosToCents(field("unitCost"));
    const margin = parsePercent(field("marginPercent"));
    if (!cost.ok || !margin.ok) {
      return json<CostActionResult>(
        {
          ok: false,
          message:
            "Unit cost must be euros of 0 or more; gross margin a percent between 0 and 100 (e.g. 72 for 72%). Leave a field empty to clear it.",
        },
        { status: 400 },
      );
    }
    // ProductMeta.grossMarginPercent stores a FRACTION 0..1 (schema).
    const grossMarginPercent =
      margin.percent == null ? null : margin.percent / 100;
    await prisma.productMeta.update({
      where: { id: meta.id },
      data: { unitCostCents: cost.cents, grossMarginPercent },
    });
    await appendAudit({
      shop,
      actorType: "STAFF",
      actorId,
      action: "product.cost_updated",
      subjectType: "ProductMeta",
      subjectId: meta.id,
      payload: {
        shopifyProductId: meta.shopifyProductId,
        unitCostCents: cost.cents,
        grossMarginPercent,
      },
    });
    return json<CostActionResult>({
      ok: true,
      message: `${meta.title}: costs saved.`,
    });
  }

  return json<CostActionResult>(
    { ok: false, message: "Unknown action." },
    { status: 400 },
  );
};

// ── UI helpers ───────────────────────────────────────────────────────────

const DIMENSION_LABELS: Record<CohortDimension, string> = {
  startMonth: "Start month",
  firstProduct: "First product",
  country: "Country",
  acquisitionChannel: "Acquisition channel",
  landingPage: "Landing page",
  advertorial: "Advertorial",
  campaign: "Campaign",
  initialDiscount: "Initial discount",
  initialQuantity: "Initial quantity",
  sellingPlanConfig: "Selling plan config",
  device: "Device",
  newVsReturning: "New vs returning",
  firstOrderAovBand: "First order AOV band",
  firstShipmentProfitBand: "First shipment profit band",
  widgetVersion: "Widget version",
};

const METRIC_LABELS: Record<CohortMetric, string> = {
  retention: "Retention",
  ltvCents: "LTV",
  contributionCents: "Contribution margin",
  subscribers: "Subscribers",
};

const MODEL_LABELS: Record<(typeof FORECAST_MODELS)[number], string> = {
  CONTRACT: "Plan-by-plan",
  SURVIVAL_TREND: "Based on your observed retention",
};

const SCENARIO_LABELS: Record<(typeof FORECAST_SCENARIOS)[number], string> = {
  BASE: "Base",
  CONSERVATIVE: "Conservative",
  OPTIMISTIC: "Optimistic",
};

/**
 * Fetch a CSV from the app.analytics.export resource route and save it
 * client-side. Plain `fetch` is patched by App Bridge to carry the session
 * token, so the request authenticates inside the embedded admin iframe —
 * a plain anchor/download navigation cannot (no id_token, no cookie).
 */
function downloadCsv(query: string, filename: string): void {
  void (async () => {
    const res = await fetch(`/app/analytics/export?${query}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  })();
}

function centsToEuroInput(cents: number | null): string {
  return cents == null ? "" : (cents / 100).toFixed(2);
}

// ── Costs tab row component ──────────────────────────────────────────────

function ProductCostRow({
  product,
  currencyCode,
  busy,
  canEdit,
  onSave,
}: {
  product: CostProductRow;
  currencyCode: string;
  busy: boolean;
  /** ANALYST is read-only: inputs disabled, no Save button. */
  canEdit: boolean;
  onSave: (productId: string, unitCost: string, marginPercent: string) => void;
}) {
  const [unitCost, setUnitCost] = useState(
    centsToEuroInput(product.unitCostCents),
  );
  const [marginPercent, setMarginPercent] = useState(
    product.grossMarginPercent == null
      ? ""
      : String(Math.round(product.grossMarginPercent * 10000) / 100),
  );
  return (
    <Box
      borderColor="border"
      borderWidth="025"
      borderRadius="200"
      padding="300"
    >
      <InlineStack gap="300" blockAlign="end" wrap>
        <Box minWidth="200px">
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            {product.title}
          </Text>
        </Box>
        <Box minWidth="140px">
          <TextField
            label={`Unit cost (${currencyCode})`}
            value={unitCost}
            onChange={setUnitCost}
            autoComplete="off"
            placeholder="e.g. 14.50"
            disabled={!canEdit}
          />
        </Box>
        <Box minWidth="140px">
          <TextField
            label="Gross margin (%)"
            value={marginPercent}
            onChange={setMarginPercent}
            autoComplete="off"
            placeholder="e.g. 72"
            helpText="Stored as a fraction"
            disabled={!canEdit}
          />
        </Box>
        {canEdit ? (
          <Button
            loading={busy}
            onClick={() => onSave(product.id, unitCost, marginPercent)}
          >
            Save
          </Button>
        ) : null}
      </InlineStack>
    </Box>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const data = useLoaderData<AnalyticsLoaderData>();
  const actionData = useActionData<CostActionResult>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [costsBannerDismissed, setCostsBannerDismissed] = useState(false);

  const busyIntent =
    navigation.state !== "idle"
      ? String(navigation.formData?.get("intent") ?? "")
      : "";
  const busyProductId =
    busyIntent === "save-product-cost"
      ? String(navigation.formData?.get("productId") ?? "")
      : "";

  const updateParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    next.set(key, value);
    setSearchParams(next);
  };

  /** Build an href that patches query params while preserving the rest. */
  const hrefWith = (patch: Record<string, string>): string => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) next.set(key, value);
    return `?${next.toString()}`;
  };
  const forecastHref = (patch: Record<string, string>): string =>
    hrefWith({ tab: "forecast", ...patch });

  const tabs = [
    { id: "cohorts", content: "Cohorts" },
    { id: "survival", content: "Survival" },
    { id: "forecast", content: "Forecast" },
    { id: "costs", content: "Costs" },
    { id: "best", content: "Best configurations" },
    { id: "export", content: "Export" },
  ];
  const selectedTab = Math.max(
    0,
    tabs.findIndex((t) => t.id === data.tab),
  );

  const currencyCode = data.currencyCode;
  const money = (cents: number) => fmtMoney(cents, currencyCode);

  // Cohort heat normalisation.
  const cohortMax =
    data.cohortTable.metric === "retention"
      ? 1
      : data.cohortTable.rows.reduce(
          (max, row) =>
            row.cells.reduce<number>(
              (m, cell) => (cell != null && cell > m ? cell : m),
              max,
            ),
          0,
        );
  const cohortMaxLabel =
    data.cohortTable.metric === "retention"
      ? fmtPct(1, 0)
      : data.cohortTable.metric === "subscribers"
        ? String(cohortMax)
        : money(cohortMax);
  const hasThinCohorts = data.cohortTable.rows.some(
    (row) => row.cohortSize < THIN_COHORT_SIZE,
  );

  const primaryCurve = data.survivalCurves[0] ?? null;
  // Checkpoints nobody has reached yet (at-risk 0, null percentages) are
  // omitted from the chart — 0/0 is "no data", never "0% remaining".
  const chartPoints = (primaryCurve?.points ?? [])
    .filter((p) => p.eligible > 0 && p.remainingPercent != null)
    .map((p) => ({
      label: p.label,
      remainingPercent: p.remainingPercent ?? 0,
      voluntaryExitPercent: p.voluntaryExitPercent ?? 0,
      paymentFailureExitPercent: p.paymentFailureExitPercent ?? 0,
    }));

  const reliability = data.forecast.reliability;
  const opts = data.forecast.options;

  // Costs form state (euros / percent in the UI; cents / fractions at rest).
  const [marginPct, setMarginPct] = useState(
    String(data.costs.defaultGrossMarginPercent),
  );
  const [shippingEur, setShippingEur] = useState(
    centsToEuroInput(data.costs.shippingPerDeliveryCents),
  );
  const [fulfillmentEur, setFulfillmentEur] = useState(
    centsToEuroInput(data.costs.fulfillmentPerDeliveryCents),
  );
  const [feePct, setFeePct] = useState(String(data.costs.paymentFeePercent));
  const [feeFixedEur, setFeeFixedEur] = useState(
    centsToEuroInput(data.costs.paymentFeeFixedCents),
  );

  const breakdown = data.costs.example.breakdown;
  const breakdownRows: Array<{ label: string; cents: number; sign: string }> = [
    { label: "Recurring revenue", cents: breakdown.revenueCents, sign: "" },
    { label: "Product costs (COGS)", cents: breakdown.cogsCents, sign: "−" },
    { label: "Shipping", cents: breakdown.shippingCents, sign: "−" },
    { label: "Fulfillment", cents: breakdown.fulfillmentCents, sign: "−" },
    { label: "Payment fees", cents: breakdown.paymentFeeCents, sign: "−" },
  ];

  const showCostsBanner =
    !data.costs.configured && !costsBannerDismissed && data.tab !== "costs";

  return (
    <Page
      title="Analytics"
      subtitle="Cohorts, survival, forecasting, costs and the configurations that compound."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {showCostsBanner ? (
              <Banner
                tone="warning"
                title="Profit numbers are using the default margin"
                onDismiss={() => setCostsBannerDismissed(true)}
                action={{
                  content: "Set up your cost model",
                  url: hrefWith({ tab: "costs" }),
                }}
              >
                <p>
                  Add your real product costs, shipping, fulfillment and
                  payment fees in the Costs tab so contribution and LTGP
                  reflect true profit.
                </p>
              </Banner>
            ) : null}

            <Card padding="0">
              <Tabs
                tabs={tabs}
                selected={selectedTab}
                onSelect={(index) => updateParam("tab", tabs[index].id)}
              >
                <Box padding="400">
                  {data.tab === "cohorts" ? (
                    <BlockStack gap="400">
                      <InlineStack gap="300" wrap>
                        <Select
                          label="Dimension"
                          options={COHORT_DIMENSIONS.map((d) => ({
                            label: DIMENSION_LABELS[d],
                            value: d,
                          }))}
                          value={data.dimension}
                          onChange={(value) => updateParam("dimension", value)}
                        />
                        <Select
                          label="Metric"
                          options={COHORT_METRICS.map((m) => ({
                            label: METRIC_LABELS[m],
                            value: m,
                          }))}
                          value={data.metric}
                          onChange={(value) => updateParam("metric", value)}
                        />
                      </InlineStack>
                      <Text as="p" tone="subdued" variant="bodySm">
                        How to read: each row follows the plans that started in
                        that cohort — M0 is the cohort&apos;s own calendar
                        month, M1 the next month, and so on; darker cells are
                        higher values and &quot;—&quot; means the cohort is too
                        young to be observed there.
                      </Text>
                      {data.cohortTable.rows.length === 0 ? (
                        <Text as="p" tone="subdued">
                          No treatment plans yet — cohorts appear once the
                          first plans start.
                        </Text>
                      ) : (
                        <BlockStack gap="300">
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="span" variant="bodySm" tone="subdued">
                              Low
                            </Text>
                            <div
                              aria-hidden="true"
                              style={{
                                width: 160,
                                height: 10,
                                borderRadius: 5,
                                background:
                                  "linear-gradient(to right, rgba(177,205,237,0.12), rgba(177,205,237,0.90))",
                              }}
                            />
                            <Text as="span" variant="bodySm" tone="subdued">
                              High ({cohortMaxLabel})
                            </Text>
                          </InlineStack>
                          <Box overflowX="scroll">
                            <DataTable
                              columnContentTypes={[
                                "text",
                                "numeric",
                                ...data.cohortTable.columns.map(
                                  () => "numeric" as const,
                                ),
                              ]}
                              headings={[
                                DIMENSION_LABELS[data.cohortTable.dimension],
                                "Plans",
                                ...data.cohortTable.columns.map((c, i) =>
                                  monthColumnLabel(c, i),
                                ),
                              ]}
                              rows={data.cohortTable.rows.map((row) => {
                                const thin = row.cohortSize < THIN_COHORT_SIZE;
                                const mute = thin
                                  ? { opacity: 0.5 }
                                  : undefined;
                                return [
                                  <span key="key" style={mute}>
                                    {row.key}
                                    {thin ? " †" : ""}
                                  </span>,
                                  <span key="size" style={mute}>
                                    {row.cohortSize}
                                  </span>,
                                  ...row.cells.map((cell, i) => (
                                    <div
                                      key={i}
                                      title={cohortCellTitle(
                                        data.cohortTable.metric,
                                        row.key,
                                        i,
                                        cell,
                                        currencyCode,
                                      )}
                                      style={{
                                        background: heatBackground(
                                          cell,
                                          cohortMax,
                                        ),
                                        borderRadius: 6,
                                        padding: "4px 8px",
                                        textAlign: "center",
                                        minWidth: 52,
                                        ...(thin ? { opacity: 0.5 } : {}),
                                      }}
                                    >
                                      {formatCohortValue(
                                        data.cohortTable.metric,
                                        cell,
                                        currencyCode,
                                      )}
                                    </div>
                                  )),
                                ];
                              })}
                            />
                          </Box>
                          {hasThinCohorts ? (
                            <Text as="p" variant="bodySm" tone="subdued">
                              † Cohorts with fewer than {THIN_COHORT_SIZE}{" "}
                              plans are muted — too small to draw conclusions
                              from.
                            </Text>
                          ) : null}
                        </BlockStack>
                      )}
                    </BlockStack>
                  ) : null}

                  {data.tab === "survival" ? (
                    <BlockStack gap="400">
                      <InlineStack gap="300" wrap>
                        <Select
                          label="Split by"
                          options={[
                            { label: "All plans", value: "all" },
                            { label: "Start month", value: "startMonth" },
                            { label: "Widget version", value: "widgetVersion" },
                            { label: "Cadence", value: "intervalWeeks" },
                          ]}
                          value={data.cohortBy}
                          onChange={(value) => updateParam("cohortBy", value)}
                        />
                      </InlineStack>
                      <Text as="p" tone="subdued" variant="bodySm">
                        How to read: the solid line is the share of plans still
                        active at each checkpoint. Exits are split clearly —
                        voluntary cancellations (customer chose to stop) vs
                        payment failures (cards that never recovered). Grey
                        values rest on fewer than {THIN_COHORT_SIZE} plans at
                        risk; hover any value for the exact counts.
                      </Text>
                      {primaryCurve && chartPoints.length > 0 ? (
                        <SurvivalChart
                          title={`Survival — ${primaryCurve.cohort} (${primaryCurve.contracts} plans)`}
                          points={chartPoints}
                        />
                      ) : null}
                      {data.survivalTotalCohorts > MAX_SURVIVAL_CURVES ? (
                        <Text as="p" variant="bodySm" tone="subdued">
                          {data.cohortBy === "startMonth"
                            ? `Showing the latest ${MAX_SURVIVAL_CURVES} of ${data.survivalTotalCohorts} cohorts.`
                            : `Showing ${MAX_SURVIVAL_CURVES} of ${data.survivalTotalCohorts} cohorts.`}
                        </Text>
                      ) : null}
                      {primaryCurve &&
                      primaryCurve.contracts > 0 &&
                      primaryCurve.points.length > 0 ? (
                        <Box overflowX="scroll">
                          <DataTable
                            columnContentTypes={[
                              "text",
                              "numeric",
                              ...primaryCurve.points.map(
                                () => "numeric" as const,
                              ),
                            ]}
                            headings={[
                              "Cohort",
                              "Plans",
                              ...primaryCurve.points.map((p) => p.label),
                            ]}
                            rows={data.survivalCurves.map((curve) => [
                              curve.cohort,
                              curve.contracts,
                              // Match cells by checkpoint label (not array
                              // position) so cohort rows stay aligned with
                              // the headings even if a curve omits
                              // checkpoints nobody has reached.
                              ...primaryCurve.points.map((heading, i) => {
                                const idx = curve.points.findIndex(
                                  (cp) => cp.label === heading.label,
                                );
                                const p = idx === -1 ? null : curve.points[idx];
                                // Additive atRisk array on the curve,
                                // parallel to points (n at each checkpoint).
                                const atRisk = p
                                  ? (curve.atRisk[idx] ?? p.eligible)
                                  : 0;
                                if (!p || atRisk === 0 || p.remainingPercent == null) {
                                  return (
                                    <span
                                      key={i}
                                      title={`${curve.cohort} · ${heading.label}: no plans old enough to be measured yet`}
                                    >
                                      —
                                    </span>
                                  );
                                }
                                const label = fmtPct(
                                  p.remainingPercent / 100,
                                  1,
                                );
                                const pending =
                                  p.pendingPercent != null &&
                                  p.pendingPercent > 0
                                    ? ` · alive but not yet at this paid order ${fmtPct(p.pendingPercent / 100, 1)}`
                                    : "";
                                const title = `${curve.cohort} · ${p.label}: ${label} remaining · ${atRisk} plan${atRisk === 1 ? "" : "s"} at risk · voluntary exits ${fmtPct((p.voluntaryExitPercent ?? 0) / 100, 1)} · payment-failure exits ${fmtPct((p.paymentFailureExitPercent ?? 0) / 100, 1)}${pending}`;
                                return atRisk < THIN_COHORT_SIZE ? (
                                  <span
                                    key={i}
                                    title={title}
                                    style={{ color: CHART_MUTED }}
                                  >
                                    {label}*
                                  </span>
                                ) : (
                                  <span key={i} title={title}>
                                    {label}
                                  </span>
                                );
                              }),
                            ])}
                          />
                        </Box>
                      ) : (
                        <Text as="p" tone="subdued">
                          Not enough history yet — the survival table fills in
                          as plans reach their first rebills.
                        </Text>
                      )}
                      <Text as="p" variant="bodySm" tone="subdued">
                        * Fewer than {THIN_COHORT_SIZE} plans at risk at this
                        checkpoint — directional only.
                      </Text>
                    </BlockStack>
                  ) : null}

                  {data.tab === "forecast" ? (
                    <BlockStack gap="400">
                      <InlineStack gap="400" wrap blockAlign="end">
                        <BlockStack gap="150">
                          <Text as="span" variant="bodySm" tone="subdued">
                            Model
                          </Text>
                          <ButtonGroup variant="segmented">
                            {FORECAST_MODELS.map((m) => (
                              <Button
                                key={m}
                                size="slim"
                                url={forecastHref({ model: m })}
                                variant={
                                  opts.model === m ? "primary" : undefined
                                }
                              >
                                {MODEL_LABELS[m]}
                              </Button>
                            ))}
                          </ButtonGroup>
                        </BlockStack>
                        <BlockStack gap="150">
                          <Text as="span" variant="bodySm" tone="subdued">
                            Scenario
                          </Text>
                          <ButtonGroup variant="segmented">
                            {FORECAST_SCENARIOS.map((s) => (
                              <Button
                                key={s}
                                size="slim"
                                url={forecastHref({ scenario: s })}
                                variant={
                                  opts.scenario === s ? "primary" : undefined
                                }
                              >
                                {SCENARIO_LABELS[s]}
                              </Button>
                            ))}
                          </ButtonGroup>
                        </BlockStack>
                        <BlockStack gap="150">
                          <Text as="span" variant="bodySm" tone="subdued">
                            Horizon
                          </Text>
                          <ButtonGroup variant="segmented">
                            {FORECAST_HORIZON_PARAMS.map((h) => (
                              <Button
                                key={h}
                                size="slim"
                                url={forecastHref({ horizon: h })}
                                variant={
                                  String(opts.horizonWeeks) === h
                                    ? "primary"
                                    : undefined
                                }
                              >
                                {`${h} weeks`}
                              </Button>
                            ))}
                          </ButtonGroup>
                        </BlockStack>
                      </InlineStack>

                      {reliability ? (
                        <Box
                          borderColor="border"
                          borderWidth="025"
                          borderRadius="200"
                          padding="400"
                          background="bg-surface-secondary"
                        >
                          <BlockStack gap="200">
                            <InlineStack gap="200" blockAlign="center" wrap>
                              <Text as="h3" variant="headingMd">
                                How much to trust this forecast
                              </Text>
                              <Badge tone={gradeTone(reliability.grade)}>
                                {reliability.grade}
                              </Badge>
                              <Text as="span" tone="subdued" variant="bodySm">
                                Expected error band{" "}
                                {reliability.expectedErrorBand}
                              </Text>
                            </InlineStack>
                            {reliability.reasons.length > 0 ? (
                              <List type="bullet">
                                {reliability.reasons.map((reason, i) => (
                                  <List.Item key={i}>{reason}</List.Item>
                                ))}
                              </List>
                            ) : null}
                          </BlockStack>
                        </Box>
                      ) : null}

                      {data.forecast.totalRows === 0 ? (
                        <Banner
                          tone="info"
                          title="Nothing to forecast yet"
                        >
                          <p>
                            The outlook is computed live from your active
                            treatment plans — it fills in as soon as the first
                            plans are running.
                          </p>
                        </Banner>
                      ) : (
                        <BlockStack gap="400">
                          <LineChart
                            title={`Expected recurring revenue by week (${opts.horizonWeeks} weeks — ${SCENARIO_LABELS[opts.scenario]} scenario)`}
                            labels={data.forecast.weekLabels.map((w) =>
                              fmtDateLabel(w),
                            )}
                            series={[
                              {
                                name: "Expected revenue",
                                values: data.forecast.weeklyRevenueCents,
                              },
                            ]}
                            formatValue={(v) => money(Math.round(v))}
                          />
                          <Text as="h3" variant="headingMd">
                            Operations view — units to have on hand
                          </Text>
                          <Box overflowX="scroll">
                            <DataTable
                              columnContentTypes={[
                                "text",
                                "text",
                                "numeric",
                                "numeric",
                                "text",
                              ]}
                              headings={[
                                "Product",
                                "SKU",
                                `Expected units (${opts.horizonWeeks}w)`,
                                `Contracted units (${opts.horizonWeeks}w)`,
                                "Weekly trend",
                              ]}
                              rows={data.forecast.ops.map((o) => [
                                o.title,
                                o.sku,
                                o.totalExpectedUnits,
                                o.totalContractedUnits,
                                <Sparkline
                                  key={o.sku}
                                  values={o.weekly}
                                  title={`Weekly expected units for ${o.title}`}
                                />,
                              ])}
                            />
                          </Box>
                          <Text as="h3" variant="headingMd">
                            Detail by week, SKU and market
                          </Text>
                          {data.forecast.totalRows > MAX_DETAIL_ROWS ? (
                            <Text as="p" variant="bodySm" tone="subdued">
                              Showing the first {MAX_DETAIL_ROWS} of{" "}
                              {data.forecast.totalRows} rows — export the full
                              snapshot from the Export tab.
                            </Text>
                          ) : null}
                          <Box overflowX="scroll">
                            <DataTable
                              columnContentTypes={[
                                "text",
                                "text",
                                "text",
                                "numeric",
                                "numeric",
                                "numeric",
                                "numeric",
                                "numeric",
                                "numeric",
                                "numeric",
                                "numeric",
                                "numeric",
                                "text",
                              ]}
                              headings={[
                                "Week",
                                "Product",
                                "Market",
                                "Contracted",
                                "Expected",
                                "Skips",
                                "Pauses",
                                "Cancels",
                                "Failed pmts",
                                "Add-ons",
                                "Revenue",
                                "Margin",
                                "95% CI",
                              ]}
                              rows={data.forecast.detailRows.map((r) => [
                                r.weekStart,
                                `${r.title} (${r.sku})`,
                                r.market,
                                r.contractedUnits,
                                r.probabilityAdjustedUnits,
                                r.expectedSkips,
                                r.expectedPauses,
                                r.expectedCancellations,
                                r.expectedFailedPayments,
                                r.expectedAddOnUnits,
                                money(r.revenueCents),
                                money(r.marginCents),
                                `${money(r.ciLowCents)} – ${money(r.ciHighCents)}`,
                              ])}
                            />
                          </Box>
                          {data.forecast.computedAt ? (
                            <Text as="p" variant="bodySm" tone="subdued">
                              {/* Deterministic UTC label — toLocaleString()
                                  differs between server and browser and
                                  breaks hydration. */}
                              Computed live from current plans at{" "}
                              {`${fmtDateLabel(data.forecast.computedAt)}, ${data.forecast.computedAt.slice(11, 16)} UTC`}
                              .
                            </Text>
                          ) : null}
                        </BlockStack>
                      )}
                    </BlockStack>
                  ) : null}

                  {data.tab === "costs" ? (
                    <BlockStack gap="400">
                      {actionData?.message ? (
                        <Banner
                          tone={actionData.ok ? "success" : "critical"}
                          title={actionData.message}
                        />
                      ) : null}

                      <Text as="h3" variant="headingMd">
                        Cost model
                      </Text>
                      <Text as="p" tone="subdued" variant="bodySm">
                        These costs turn revenue into true contribution profit
                        (LTGP) across every dashboard, cohort and forecast.
                        Amounts are entered in {currencyCode} and stored as
                        integer cents.
                      </Text>
                      {!data.canEditCosts ? (
                        <Text as="p" variant="bodySm" tone="subdued">
                          Read-only: your role can view costs but not edit
                          them.
                        </Text>
                      ) : null}
                      {!data.costs.configured ? (
                        <Text as="p" variant="bodySm" tone="caution">
                          Not configured yet — profit metrics fall back to the
                          default margin until you save this form.
                        </Text>
                      ) : null}
                      <FormLayout>
                        <FormLayout.Group>
                          <TextField
                            label="Default gross margin (%)"
                            value={marginPct}
                            onChange={setMarginPct}
                            autoComplete="off"
                            helpText="Used when a product has no cost data. 0–100, e.g. 70."
                            disabled={!data.canEditCosts}
                          />
                          <TextField
                            label={`Shipping per delivery (${currencyCode})`}
                            value={shippingEur}
                            onChange={setShippingEur}
                            autoComplete="off"
                            helpText="What Cellexia pays per shipment, e.g. 4.90."
                            disabled={!data.canEditCosts}
                          />
                          <TextField
                            label={`Fulfillment per delivery (${currencyCode})`}
                            value={fulfillmentEur}
                            onChange={setFulfillmentEur}
                            autoComplete="off"
                            helpText="Pick, pack and 3PL cost per shipment."
                            disabled={!data.canEditCosts}
                          />
                        </FormLayout.Group>
                        <FormLayout.Group>
                          <TextField
                            label="Payment fee (%)"
                            value={feePct}
                            onChange={setFeePct}
                            autoComplete="off"
                            helpText="Percentage of order value per charge, e.g. 1.9."
                            disabled={!data.canEditCosts}
                          />
                          <TextField
                            label={`Payment fee fixed (${currencyCode})`}
                            value={feeFixedEur}
                            onChange={setFeeFixedEur}
                            autoComplete="off"
                            helpText="Fixed amount per charge, e.g. 0.30."
                            disabled={!data.canEditCosts}
                          />
                        </FormLayout.Group>
                        {data.canEditCosts ? (
                          <Button
                            variant="primary"
                            loading={busyIntent === "save-cost-model"}
                            onClick={() =>
                              submit(
                                {
                                  intent: "save-cost-model",
                                  defaultGrossMarginPercent: marginPct,
                                  shippingPerDelivery: shippingEur,
                                  fulfillmentPerDelivery: fulfillmentEur,
                                  paymentFeePercent: feePct,
                                  paymentFeeFixed: feeFixedEur,
                                },
                                { method: "post" },
                              )
                            }
                          >
                            Save cost model
                          </Button>
                        ) : null}
                      </FormLayout>

                      <Divider />

                      <Text as="h3" variant="headingMd">
                        Per-product costs (COGS)
                      </Text>
                      <Text as="p" tone="subdued" variant="bodySm">
                        A unit cost beats a margin estimate — when both are
                        set, the unit cost wins. Margin is entered as a percent
                        (e.g. 72) and stored as a fraction. Leave a field empty
                        to clear it.
                      </Text>
                      {data.costs.products.length === 0 ? (
                        <Text as="p" tone="subdued">
                          No products synced yet — products appear here after
                          the first product sync from Shopify.
                        </Text>
                      ) : (
                        <BlockStack gap="200">
                          {data.costs.products.map((product) => (
                            <ProductCostRow
                              key={product.id}
                              product={product}
                              currencyCode={currencyCode}
                              busy={busyProductId === product.id}
                              canEdit={data.canEditCosts}
                              onSave={(productId, unitCost, marginPercent) =>
                                submit(
                                  {
                                    intent: "save-product-cost",
                                    productId,
                                    unitCost,
                                    marginPercent,
                                  },
                                  { method: "post" },
                                )
                              }
                            />
                          ))}
                        </BlockStack>
                      )}

                      <Divider />

                      <Text as="h3" variant="headingMd">
                        Live example — profit on one order (LTGP)
                      </Text>
                      <Text as="p" tone="subdued" variant="bodySm">
                        Contribution = revenue − COGS − shipping − fulfillment
                        − payment fees. This exact formula sits behind every
                        profit number in Cellexia. Based on{" "}
                        {data.costs.example.source}.
                      </Text>
                      <Box
                        borderColor="border"
                        borderWidth="025"
                        borderRadius="200"
                        padding="400"
                        maxWidth="440px"
                      >
                        <BlockStack gap="200">
                          {data.costs.example.lines.map((line, i) => (
                            <Text as="p" variant="bodySm" key={i}>
                              {line.quantity} × {line.title} @{" "}
                              {money(line.priceCents)}
                            </Text>
                          ))}
                          <Divider />
                          {breakdownRows.map((row) => (
                            <InlineStack
                              key={row.label}
                              align="space-between"
                              gap="400"
                            >
                              <Text as="span" variant="bodyMd">
                                {row.sign ? `${row.sign} ` : ""}
                                {row.label}
                              </Text>
                              <Text as="span" variant="bodyMd">
                                {row.sign}
                                {money(row.cents)}
                              </Text>
                            </InlineStack>
                          ))}
                          <Divider />
                          <InlineStack align="space-between" gap="400">
                            <Text as="span" variant="bodyMd" fontWeight="bold">
                              = Contribution (LTGP)
                            </Text>
                            <Text as="span" variant="bodyMd" fontWeight="bold">
                              {money(breakdown.contributionCents)}
                            </Text>
                          </InlineStack>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {fmtPct(breakdown.contributionFraction, 1)} of
                            revenue stays after all delivery costs.
                          </Text>
                        </BlockStack>
                      </Box>
                    </BlockStack>
                  ) : null}

                  {data.tab === "best" ? (
                    <BlockStack gap="400">
                      <Text as="p" tone="subdued">
                        Which acquisition source, introductory offer, first
                        product and cadence produce the highest 12-month
                        contribution margin per plan. Combos with few mature
                        plans are directional, not proven.
                      </Text>
                      {data.bestConfigs.length === 0 ? (
                        <Text as="p" tone="subdued">
                          No plans yet — best configurations appear once plans
                          accumulate billing history.
                        </Text>
                      ) : (
                        <Box overflowX="scroll">
                          <DataTable
                            columnContentTypes={[
                              "text",
                              "text",
                              "text",
                              "numeric",
                              "numeric",
                              "numeric",
                              "numeric",
                              "numeric",
                            ]}
                            headings={[
                              "Source",
                              "Offer",
                              "First product",
                              "Cadence (weeks)",
                              "Plans",
                              "Mature (12m+)",
                              "Avg 12-mo contribution",
                              "Total contribution",
                            ]}
                            rows={data.bestConfigs.map((b) => [
                              b.source,
                              b.offer,
                              b.product,
                              b.cadenceWeeks,
                              b.contracts,
                              b.matureContracts,
                              money(b.avgContribution12mCents),
                              money(b.totalContribution12mCents),
                            ])}
                          />
                        </Box>
                      )}
                    </BlockStack>
                  ) : null}

                  {data.tab === "export" ? (
                    <BlockStack gap="400">
                      <Text as="p" tone="subdued">
                        Download raw data as CSV for spreadsheets or BI tools.
                        Values that could be read as spreadsheet formulas are
                        neutralised automatically.
                      </Text>
                      <InlineStack gap="300" wrap>
                        <Button
                          onClick={() =>
                            downloadCsv(
                              "export=contracts",
                              "cellexia-contracts.csv",
                            )
                          }
                        >
                          Treatment plans (contracts)
                        </Button>
                        <Button
                          onClick={() =>
                            downloadCsv("export=events", "cellexia-events.csv")
                          }
                        >
                          Lifecycle events (latest 10,000)
                        </Button>
                        <Button
                          onClick={() =>
                            downloadCsv(
                              "export=forecast",
                              "cellexia-forecast.csv",
                            )
                          }
                        >
                          Forecast snapshot (latest)
                        </Button>
                        <Button
                          onClick={() =>
                            downloadCsv(
                              `export=cohorts&dimension=${data.dimension}&metric=${data.metric}`,
                              `cellexia-cohorts-${data.dimension}-${data.metric}.csv`,
                            )
                          }
                        >
                          Cohort table ({DIMENSION_LABELS[data.dimension]} x{" "}
                          {METRIC_LABELS[data.metric]})
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  ) : null}
                </Box>
              </Tabs>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
