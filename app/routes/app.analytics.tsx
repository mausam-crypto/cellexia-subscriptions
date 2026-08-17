import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { LoaderFunctionArgs, SerializeFrom } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  DataTable,
  EmptyState,
  InlineGrid,
  InlineStack,
  List,
  Page,
  Select,
  Tabs,
  Text,
} from "@shopify/polaris";
import { toZonedTime, format as formatTz } from "date-fns-tz";

import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import {
  getCostCoverage,
  getForecast,
  getFunnelMetrics,
  getLtgpSummary,
  getPredictedLtgpSummary,
  getRiskModelStatus,
  getSegmentChurnSeries,
  getSegmentCohortData,
  getSegmentForecast,
  getSegmentHeadline,
  getSegmentOptions,
  getSurvivalByCycle,
  isEmptySegment,
  loadSegmentSourceContracts,
  parseSegmentFromParams,
  resolveSegmentContractIds,
} from "~/lib/analytics/index.server";
import type { ForecastModelChoice } from "~/lib/analytics/index.server";
import { getInsights } from "~/lib/analytics/insights.server";
import { getSetting } from "~/lib/settings/settings.server";
import {
  SEGMENT_PARAM_NAMES,
  UNKNOWN_SEGMENT_VALUE,
  segmentValueLabel,
} from "~/lib/analytics/segments-shared";
import type { SegmentDimension } from "~/lib/analytics/segments-shared";
import { formatMoney } from "~/lib/money";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";
import {
  AccuracyGradeChip,
  CohortHeatmap,
  ForecastChart,
  InsightCards,
  SplitBar,
  StatCard,
  SurvivalCurve,
  TargetBand,
  CHART_COLORS,
  compactMoney,
  compactNumber,
  dateKeyLabel,
  finite,
  monthKeyLabel,
} from "~/components/charts";
import type { HeatmapCell, HeatmapRow } from "~/components/charts";

const RANGE_OPTIONS = [30, 60, 90] as const;
const TAB_IDS = ["overview", "cohorts", "survival", "forecast"] as const;
const MODEL_CHOICES = [
  "auto",
  "naive",
  "trend",
  "seasonal",
  "cohort",
  "blend",
] as const;
const HORIZON_OPTIONS = [12, 26, 52] as const;

/** Heatmap caps: newest cohorts, first year of life. */
const MAX_HEATMAP_COHORTS = 12;
const MAX_HEATMAP_OFFSET = 12;

/**
 * Survival is gated until this many contracts have "decided" (churned, or
 * been billed at least twice) — below this the curve is statistical noise.
 */
const SURVIVAL_MIN_DECIDED = 10;

/** Playbook target bands (fractions). */
const DUNNING_TARGET = { min: 0.55, max: 0.7 };
const SAVE_TARGET = { min: 0.2, max: 0.3 };

function ymIndex(ym: string): number {
  const [y, m] = ym.split("-").map(Number);
  return (y || 0) * 12 + ((m || 1) - 1);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const rangeParam = Number(url.searchParams.get("range"));
  const rangeDays = (RANGE_OPTIONS as readonly number[]).includes(rangeParam)
    ? rangeParam
    : 30;
  const tabParam = url.searchParams.get("tab");
  const initialTab = (TAB_IDS as readonly string[]).includes(tabParam ?? "")
    ? (tabParam as (typeof TAB_IDS)[number])
    : "overview";
  const modelParam = url.searchParams.get("model");
  const modelChoice: ForecastModelChoice = (
    MODEL_CHOICES as readonly string[]
  ).includes(modelParam ?? "")
    ? (modelParam as ForecastModelChoice)
    : "auto";
  const horizonParam = Number(url.searchParams.get("horizon"));
  const horizonWeeks = (HORIZON_OPTIONS as readonly number[]).includes(horizonParam)
    ? horizonParam
    : 12;

  const shop = await getPrimaryShop();
  if (!shop) {
    return json({ ready: false as const, rangeDays, initialTab });
  }

  const now = new Date();

  // ── Segment resolution (v1.15.0) — an active filter swaps every view to a
  // live computation over the segment's contract ids; the persisted
  // shop-level tables keep serving the unfiltered page. Options always load
  // (the filter bar renders on both); ONE book scan feeds both the options
  // and the id resolution.
  const segment = parseSegmentFromParams(url.searchParams);
  const segmentSource = await loadSegmentSourceContracts(shop.id);
  const [segmentOptions, segmentIds] = await Promise.all([
    getSegmentOptions(shop.id, { contracts: segmentSource }),
    isEmptySegment(segment)
      ? Promise.resolve(null)
      : resolveSegmentContractIds(shop.id, segment, {
          contracts: segmentSource,
        }),
  ]);
  const segmentActive = segmentIds != null;
  const contractIdFilter = segmentActive ? { id: { in: segmentIds } } : {};

  // ONE forecast run per page load: insights reuse this promise's accuracy
  // grade for rule 7 instead of getInsights self-computing a duplicate
  // forecast (~5 queries + the full rollup history fetch). A failed forecast
  // degrades insights to "no grade" (the known-unknown contract) — the
  // Promise.all still rejects on the forecast element itself, unchanged.
  // Segment views run their own forecast (reconstructed history) and hide
  // the store-wide insight cards, so neither is loaded then.
  const forecastPromise = segmentActive
    ? null
    : getForecast(shop.id, { model: modelChoice, horizonWeeks, now });
  const [
    funnel,
    survival,
    costCoverage,
    riskModel,
    costModel,
    analyticsOptions,
    cancelGroups,
    decidedContracts,
  ] = await Promise.all([
    getFunnelMetrics(shop.id, rangeDays, { contractIds: segmentIds }),
    getSurvivalByCycle(shop.id, { contractIds: segmentIds }),
    getCostCoverage(shop.id),
    getRiskModelStatus(shop.id),
    getSetting(shop.id, "costModel"),
    getSetting(shop.id, "analytics"),
    prisma.subscriptionContract.groupBy({
      by: ["cancelSource"],
      // OURS_ONLY: another subscription app's churn is not ours to report on.
      // isDemo excluded, and consolidation merges (reason MERGED) are NOT
      // churn — the customer stayed, their contracts were combined.
      where: {
        shopId: shop.id,
        status: "CANCELLED",
        isDemo: false,
        ...OURS_ONLY,
        ...contractIdFilter,
        NOT: { cancelReason: "MERGED" },
      },
      _count: { _all: true },
    }),
    prisma.subscriptionContract.count({
      where: {
        shopId: shop.id,
        isDemo: false,
        ...OURS_ONLY,
        ...contractIdFilter,
        OR: [{ status: "CANCELLED" }, { ordersCount: { gte: 2 } }],
      },
    }),
  ]);

  // ── Cohorts + forecast + insights, per path (shared post-processing below) ──
  type CohortCellRow = {
    cohortMonth: string;
    monthOffset: number;
    cohortSize: number;
    activeRemaining: number;
    cumGrossProfitCents: number;
  };
  let ltgp: Awaited<ReturnType<typeof getLtgpSummary>>;
  let cohortCells: CohortCellRow[];
  let insights: Awaited<ReturnType<typeof getInsights>>;
  let forecastData: {
    requestedModel: ForecastModelChoice;
    selectedModel: string;
    horizonWeeks: number;
    accuracy: { grade: "A" | "B" | "C" | "D"; label: string; reasons: string[] };
    models: Array<{
      key: string;
      label: string;
      available: boolean;
      minWeeksRequired: number;
      backtestMape: number | null;
      backtestBias: number | null;
      recommended: boolean;
    }>;
    modelHistory: { weeksRecorded: number; latestWeek: string | null };
    metrics: {
      mrrCents: SerializedMetricSeries | null;
      activeSubscribers: SerializedMetricSeries;
      netRevenueCents: SerializedMetricSeries;
    };
    legacyModel: {
      avgCycleSurvival: number;
      weeklyRetention: number;
      avgIntervalWeeks: number;
    } | null;
  };
  let segmentHeadline: {
    totalContracts: number;
    activeSubscribers: number;
    mrrCents: number;
  } | null = null;
  let segmentChurnSeries: Awaited<
    ReturnType<typeof getSegmentChurnSeries>
  > | null = null;

  if (!segmentActive) {
    const [ltgpResult, cells, forecast, insightsResult] = await Promise.all([
      getLtgpSummary(shop.id),
      prisma.cohortCell.findMany({
        where: { shopId: shop.id },
        orderBy: [{ cohortMonth: "asc" }, { monthOffset: "asc" }],
        select: {
          cohortMonth: true,
          monthOffset: true,
          cohortSize: true,
          activeRemaining: true,
          cumGrossProfitCents: true,
        },
      }),
      forecastPromise!,
      forecastPromise!.then(
        (f) => getInsights(shop.id, now, { forecastGrade: f.accuracy.grade }),
        () => getInsights(shop.id, now, { forecastGrade: null }),
      ),
    ]);
    ltgp = ltgpResult;
    cohortCells = cells;
    insights = insightsResult;
    forecastData = {
      requestedModel: modelChoice,
      selectedModel: forecast.selectedModel,
      horizonWeeks: forecast.horizonWeeks,
      accuracy: forecast.accuracy,
      models: forecast.models,
      modelHistory: forecast.modelHistory,
      metrics: {
        mrrCents: forecast.series.mrrCents,
        activeSubscribers: forecast.series.activeSubscribers,
        netRevenueCents: forecast.series.netRevenueCents,
      },
      legacyModel: forecast.model,
    };
  } else {
    const [cohortData, segForecast, headline, churnSeries] = await Promise.all([
      getSegmentCohortData(shop.id, segmentIds, now),
      getSegmentForecast(shop.id, segmentIds, {
        model: modelChoice,
        horizonWeeks,
        now,
      }),
      getSegmentHeadline(shop.id, segmentIds, shop.currencyCode),
      getSegmentChurnSeries(shop.id, segmentIds, { weekCount: 12, now }),
    ]);
    ltgp = cohortData.ltgp;
    cohortCells = cohortData.rows.map((row) => ({
      cohortMonth: row.cohortMonth,
      monthOffset: row.monthOffset,
      cohortSize: row.cohortSize,
      activeRemaining: row.activeRemaining,
      cumGrossProfitCents: row.cumGrossProfitCents,
    }));
    insights = []; // insight rules are store-wide; a filtered page must not imply otherwise
    segmentHeadline = headline;
    segmentChurnSeries = churnSeries;
    forecastData = {
      requestedModel: modelChoice,
      selectedModel: segForecast.selectedModel,
      horizonWeeks: segForecast.horizonWeeks,
      accuracy: segForecast.accuracy,
      models: segForecast.models.map((m) => ({
        key: m.key,
        label: m.label,
        available: m.available,
        minWeeksRequired: m.minWeeksRequired,
        backtestMape: m.backtestMape,
        backtestBias: m.backtestBias,
        recommended: m.recommended ?? false,
      })),
      modelHistory: { weeksRecorded: 0, latestWeek: null },
      metrics: {
        // Per-segment MRR history cannot be reconstructed — the tab explains.
        mrrCents: null,
        activeSubscribers: segForecast.series.activeSubscribers,
        netRevenueCents: segForecast.series.netRevenueCents,
      },
      legacyModel: null,
    };
  }

  // ── Churn split: one taxonomy — CUSTOMER/ADMIN/EXTERNAL voluntary
  // (EXTERNAL = a Shopify-admin/other-surface cancel the sync observed
  // first; somebody chose it — the same non-DUNNING-is-voluntary rule the
  // survival curves and DailyRollup apply), DUNNING involuntary,
  // SYSTEM/unknown its own bucket (never silently "voluntary").
  let voluntaryChurn = 0;
  let involuntaryChurn = 0;
  let systemChurn = 0;
  for (const group of cancelGroups) {
    if (group.cancelSource === "DUNNING") involuntaryChurn += group._count._all;
    else if (
      group.cancelSource === "CUSTOMER" ||
      group.cancelSource === "ADMIN" ||
      group.cancelSource === "EXTERNAL"
    )
      voluntaryChurn += group._count._all;
    else systemChurn += group._count._all;
  }

  // ── Cohort heatmap source rows (newest cohorts, offsets ≤ 12 months) ──
  const tz = shop.ianaTimezone;
  const nowYmIdx = ymIndex(
    formatTz(toZonedTime(now, tz), "yyyy-MM", { timeZone: tz }),
  );
  const cohortMonths = [...new Set(cohortCells.map((c) => c.cohortMonth))].sort();
  const keptMonths = new Set(cohortMonths.slice(-MAX_HEATMAP_COHORTS));
  const heatmapSource = cohortMonths
    .filter((m) => keptMonths.has(m))
    .map((cohortMonth) => {
      const cells = cohortCells.filter(
        (c) => c.cohortMonth === cohortMonth && c.monthOffset <= MAX_HEATMAP_OFFSET,
      );
      const cohortIdx = ymIndex(cohortMonth);
      return {
        cohortMonth,
        cohortSize: cells[0]?.cohortSize ?? 0,
        cells: cells.map((c) => ({
          offset: c.monthOffset,
          activeRemaining: c.activeRemaining,
          cumGrossProfitCents: c.cumGrossProfitCents,
          inProgress: cohortIdx + c.monthOffset === nowYmIdx,
        })),
      };
    });
  const heatmapMaxOffset = Math.min(
    MAX_HEATMAP_OFFSET,
    heatmapSource.reduce(
      (max, row) => Math.max(max, ...row.cells.map((c) => c.offset)),
      0,
    ),
  );

  // ── LTGP totals from the RAW cumulative cents (not per-sub × size, which
  // reintroduces up to ±size/2 cents of rounding error per cell). A horizon's
  // total is only reported when the per-sub figure is (same aging gate).
  const rawTotals = new Map<string, Map<number, number>>();
  for (const cell of cohortCells) {
    if (cell.monthOffset === 3 || cell.monthOffset === 6 || cell.monthOffset === 12) {
      const byOffset = rawTotals.get(cell.cohortMonth) ?? new Map<number, number>();
      byOffset.set(cell.monthOffset, cell.cumGrossProfitCents);
      rawTotals.set(cell.cohortMonth, byOffset);
    }
  }
  const ltgpRows = ltgp.cohorts.map((c) => ({
    ...c,
    totalM3Cents:
      c.ltgpM3Cents != null ? (rawTotals.get(c.cohortMonth)?.get(3) ?? null) : null,
    totalM6Cents:
      c.ltgpM6Cents != null ? (rawTotals.get(c.cohortMonth)?.get(6) ?? null) : null,
    totalM12Cents:
      c.ltgpM12Cents != null ? (rawTotals.get(c.cohortMonth)?.get(12) ?? null) : null,
  }));

  // ── Predicted LTGP (v1.21.0): forward-looking overlay for the same tab.
  // Contained — a scoring gap must never blank the actuals beside it.
  const predictedLtgp = await getPredictedLtgpSummary(shop.id, {
    contractIds: segmentActive ? segmentIds : null,
    now,
  }).catch((err) => {
    console.error("[analytics] predicted ltgp summary failed", err);
    return null;
  });

  return json({
    ready: true as const,
    rangeDays,
    initialTab,
    currencyCode: shop.currencyCode,
    funnel,
    insights,
    costCoverage: {
      totalLines: costCoverage.totalLines,
      linesWithKnownCogsPct: costCoverage.linesWithKnownCogsPct,
      revenueWithKnownCogsPct: costCoverage.revenueWithKnownCogsPct,
      productsMissingCount: costCoverage.productsMissingCogs.length,
      sampleProductTitles: costCoverage.productsMissingCogs
        .slice(0, 5)
        .map((p) => p.title),
    },
    vatEnabled: costModel.vat.enabled,
    excludeRefunded: analyticsOptions.excludeRefundedPayments,
    segment,
    segmentActive,
    segmentOptions,
    segmentHeadline,
    segmentChurnSeries,
    ltgpRows,
    ltgpWeightedAvg: ltgp.weightedAvg,
    predictedLtgp,
    heatmap: { rows: heatmapSource, maxOffset: heatmapMaxOffset },
    survival,
    decidedContracts,
    riskModel,
    forecast: forecastData,
    churnSplit: { voluntaryChurn, involuntaryChurn, systemChurn },
  });
};

type LoaderData = SerializeFrom<typeof loader>;
type ReadyData = Extract<LoaderData, { ready: true }>;

// ── Formatting helpers ────────────────────────────────────────────────────────
// Convention: *Pct fields are 0–100; everything else percent-like is a 0–1
// fraction. Both go through these two formatters — never inline math.

function humanizeCode(code: string): string {
  const lower = code.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** 0–1 fraction → "27.3%". */
function pctFrom01(fraction: number | null | undefined, digits = 1): string {
  return fraction == null ? "—" : `${(finite(fraction) * 100).toFixed(digits)}%`;
}

/** 0–100 percentage → "27.3%". */
function pctFrom100(pct: number | null | undefined, digits = 1): string {
  return pct == null ? "—" : `${finite(pct).toFixed(digits)}%`;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const data = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const [selected, setSelected] = useState(() =>
    Math.max(0, TAB_IDS.indexOf(data.initialTab as (typeof TAB_IDS)[number])),
  );

  const handleTabSelect = useCallback(
    (index: number) => {
      setSelected(index);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("tab", TAB_IDS[index] ?? "overview");
          return next;
        },
        { preventScrollReset: true, replace: true },
      );
    },
    [setSearchParams],
  );

  if (!data.ready) {
    return (
      <Page title="Analytics">
        <Card>
          <EmptyState
            heading="No data to analyze yet"
            action={{ content: "Create a plan", url: "/app/plans" }}
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <p>
              Analytics fill in once subscribers exist. Start by creating a
              subscription plan on the Plans page.
            </p>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  const tabs = [
    { id: "overview", content: "Overview" },
    { id: "cohorts", content: "Cohorts & LTGP" },
    { id: "survival", content: "Survival & churn" },
    { id: "forecast", content: "Forecast" },
  ];

  return (
    <Page
      title="Analytics"
      subtitle="Funnel, cohort profitability, retention and forecasts"
    >
      <BlockStack gap="400">
        <SegmentFilterBar data={data} />
        {data.segmentActive && <SegmentBanner data={data} />}
        <Tabs tabs={tabs} selected={selected} onSelect={handleTabSelect}>
          <Box paddingBlockStart="400">
            {selected === 0 && <OverviewTab data={data} />}
            {selected === 1 && <CohortsTab data={data} />}
            {selected === 2 && <SurvivalTab data={data} />}
            {selected === 3 && <ForecastTab data={data} />}
          </Box>
        </Tabs>
      </BlockStack>
    </Page>
  );
}

// ── Segment filter bar ────────────────────────────────────────────────────────

/** One Select per dimension; "" = no filter on that dimension. */
const SEGMENT_SELECTS: Array<{
  dimension: SegmentDimension;
  label: string;
  allLabel: string;
  optionsKey:
    | "countries"
    | "languages"
    | "sources"
    | "products"
    | "discountBands"
    | "devices"
    | "valueBands"
    | "designs"
    | "preselects";
}> = [
  { dimension: "country", label: "Country", allLabel: "All countries", optionsKey: "countries" },
  { dimension: "language", label: "Language", allLabel: "All languages", optionsKey: "languages" },
  { dimension: "source", label: "Traffic source", allLabel: "All sources", optionsKey: "sources" },
  { dimension: "productId", label: "Product", allLabel: "All products", optionsKey: "products" },
  {
    dimension: "discountBand",
    label: "First-order discount",
    allLabel: "Any discount",
    optionsKey: "discountBands",
  },
  { dimension: "device", label: "Device", allLabel: "All devices", optionsKey: "devices" },
  {
    dimension: "valueBand",
    label: "First-order value",
    allLabel: "Any value",
    optionsKey: "valueBands",
  },
  // v1.26.0 design measurement: which buy-box design / preselected option
  // the subscriber's first checkout came through. Segment views compare
  // subscriber OUTCOMES per design; take rate by design (an orders-based
  // denominator) lives in Buy box designer → Results, not here.
  {
    dimension: "design",
    label: "Buy-box design",
    allLabel: "All designs",
    optionsKey: "designs",
  },
  {
    dimension: "preselect",
    label: "Preselected option",
    allLabel: "Any preselect",
    optionsKey: "preselects",
  },
];

function SegmentFilterBar({ data }: { data: ReadyData }) {
  const [, setSearchParams] = useSearchParams();
  const { segment, segmentOptions, segmentActive } = data;

  const setDimension = useCallback(
    (dimension: SegmentDimension) => (value: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value === "") next.delete(SEGMENT_PARAM_NAMES[dimension]);
          else next.set(SEGMENT_PARAM_NAMES[dimension], value);
          return next;
        },
        { preventScrollReset: true },
      );
    },
    [setSearchParams],
  );

  const clearAll = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const param of Object.values(SEGMENT_PARAM_NAMES)) {
          next.delete(param);
        }
        return next;
      },
      { preventScrollReset: true },
    );
  }, [setSearchParams]);

  return (
    <Card>
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingSm">
            Filter every view
          </Text>
          {segmentActive && (
            <Button variant="plain" onClick={clearAll}>
              Clear filters
            </Button>
          )}
        </InlineStack>
        {/* Nine selects since v1.26.0: five per row on large screens (two
            rows) rather than nine hairline-narrow columns whose labels and
            option text would truncate. */}
        <InlineGrid columns={{ xs: 1, sm: 2, md: 3, lg: 5 }} gap="200">
          {SEGMENT_SELECTS.map((def) => {
            const options = segmentOptions[def.optionsKey];
            const current = segment[def.dimension] ?? "";
            const known = options.some((o) => o.value === current);
            return (
              <Select
                key={def.dimension}
                label={def.label}
                options={[
                  { label: def.allLabel, value: "" },
                  // Keep an active value selectable even when it no longer
                  // appears in the option scan (deleted product, empty value).
                  ...(current !== "" && !known
                    ? [{ label: current, value: current }]
                    : []),
                  ...options.map((option) => ({
                    label: `${
                      def.dimension === "productId"
                        ? option.label
                        : segmentValueLabel(def.dimension, option.value)
                    } (${option.count})`,
                    value: option.value,
                  })),
                ]}
                value={current}
                onChange={setDimension(def.dimension)}
              />
            );
          })}
        </InlineGrid>
      </BlockStack>
    </Card>
  );
}

function SegmentBanner({ data }: { data: ReadyData }) {
  const { segment, segmentHeadline, segmentOptions, currencyCode } = data;
  const parts = SEGMENT_SELECTS.filter((def) => segment[def.dimension] != null).map(
    (def) => {
      const value = segment[def.dimension]!;
      const label =
        def.dimension === "productId"
          ? (segmentOptions.products.find((p) => p.value === value)?.label ?? value)
          : segmentValueLabel(def.dimension, value);
      return `${def.label}: ${label}`;
    },
  );
  return (
    <Banner tone="info" title={`Filtered view — ${parts.join(" · ")}`}>
      <p>
        {segmentHeadline
          ? `${segmentHeadline.totalContracts.toLocaleString("en")} of ${segmentOptions.totalContracts.toLocaleString(
              "en",
            )} subscribers match (all statuses, all time) — ${segmentHeadline.activeSubscribers.toLocaleString(
              "en",
            )} active, ${formatMoney(segmentHeadline.mrrCents, currencyCode)} MRR. `
          : ""}
        Every tab below is computed live from source records for this segment.
        Store-wide items that cannot be filtered are hidden (take rate,
        insight cards, the cost-coverage banner); the risk-scoring chip
        describes the store-wide engine. Segments group by each
        subscriber&rsquo;s current delivery country, language and first-order
        acquisition data; imported or pre-tracking subscribers appear under
        &ldquo;{segmentValueLabel("device", UNKNOWN_SEGMENT_VALUE)}&rdquo;.
        Buy-box design and preselected option compare subscriber outcomes
        per design. Take rate by design lives in Buy box designer &rarr;
        Results.
      </p>
    </Banner>
  );
}

// ── Overview ──────────────────────────────────────────────────────────────────

/**
 * Risk-calibration chip (honesty invariant): learned mode is never shown
 * without its holdout AUC and outcome sample count; heuristic mode says when
 * the learned model will take over.
 */
function RiskModelChip({ riskModel }: { riskModel: ReadyData["riskModel"] }) {
  const learned = riskModel.mode === "learned";
  return (
    <InlineStack gap="200" blockAlign="center" wrap={false}>
      <Badge tone={learned ? "success" : "info"}>
        {learned ? "Learned model" : "Heuristic"}
      </Badge>
      <Text as="span" variant="bodySm" tone="subdued">
        {learned
          ? `Risk scoring: learned model, AUC ${
              riskModel.auc != null ? riskModel.auc.toFixed(2) : "—"
            }, trained on ${riskModel.samples.toLocaleString("en")} outcomes`
          : `Risk scoring: heuristic — learns automatically once ~${riskModel.outcomesNeeded} churn outcomes exist${
              riskModel.samples > 0
                ? ` (${riskModel.samples.toLocaleString("en")} decided so far)`
                : ""
            }`}
      </Text>
    </InlineStack>
  );
}

function OverviewTab({ data }: { data: ReadyData }) {
  const [, setSearchParams] = useSearchParams();
  const { funnel, rangeDays, insights, riskModel, segmentActive } = data;

  const handleRangeChange = useCallback(
    (value: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("range", value);
          return next;
        },
        { preventScrollReset: true },
      );
    },
    [setSearchParams],
  );

  const windowLabel = `last ${rangeDays} days`;

  // Overall save rate across reasons (each *saveRate* below is a 0–1 fraction).
  const saveSessions = funnel.saveRateByReason.reduce((sum, r) => sum + r.sessions, 0);
  const saveSaved = funnel.saveRateByReason.reduce((sum, r) => sum + r.saved, 0);
  const overallSaveRate = saveSessions > 0 ? saveSaved / saveSessions : null;

  const saveRateRows = funnel.saveRateByReason.map((row) => [
    humanizeCode(row.reason),
    row.sessions,
    row.saved,
    pctFrom01(row.saveRate),
    <Button key={row.reason} url="/app/cancel-flow" variant="plain">
      Configure offers
    </Button>,
  ]);

  return (
    <BlockStack gap="400">
      {!segmentActive && insights.length > 0 && (
        <InsightCards insights={insights} />
      )}

      <RiskModelChip riskModel={riskModel} />

      <InlineStack align="space-between" blockAlign="center">
        <Text as="h2" variant="headingMd">
          Conversion &amp; retention funnel
        </Text>
        <Box minWidth="180px">
          <Select
            label="Date range"
            labelHidden
            options={RANGE_OPTIONS.map((d) => ({
              label: `Last ${d} days`,
              value: String(d),
            }))}
            value={String(rangeDays)}
            onChange={handleRangeChange}
          />
        </Box>
      </InlineStack>

      <InlineGrid columns={{ xs: 1, sm: 2, lg: 3 }} gap="400">
        <StatCard
          title={`Subscription take rate (${windowLabel})`}
          value={pctFrom100(funnel.takeRatePct)}
          helpText={
            segmentActive
              ? "Take rate is a storefront checkout metric — its denominator exists before any subscription does, so it cannot be filtered by segment."
              : funnel.takeRatePct != null
                ? "Renewal orders are excluded from the checkout counter as of v1.4.0; days recorded before that include them and read lower. Imports can push this above 100%."
                : "Shows a value once the storefront checkout counter starts reporting subscribable checkouts."
          }
        />
        <Card>
          <BlockStack gap="150">
            <Text as="h3" variant="headingSm" tone="subdued">
              Dunning recovery rate ({windowLabel})
            </Text>
            <Text as="p" variant="headingLg">
              {pctFrom01(funnel.dunningRecoveryRate)}
            </Text>
            {funnel.dunningRecoveryRate != null ? (
              <TargetBand
                value={funnel.dunningRecoveryRate}
                targetMin={DUNNING_TARGET.min}
                targetMax={DUNNING_TARGET.max}
                scaleMax={1}
                accessibilityLabel="Dunning recovery rate vs the 55 to 70 percent target"
              />
            ) : (
              <Text as="p" variant="bodySm" tone="subdued">
                Appears once failed-payment cases have been resolved in this
                window.
              </Text>
            )}
            <Text as="p" variant="bodySm" tone="subdued">
              Of failed-payment cases closed in this window, the share where
              the money was recovered. Healthy dunning recovers 55–70%.
            </Text>
          </BlockStack>
        </Card>
        <Card>
          <BlockStack gap="150">
            <Text as="h3" variant="headingSm" tone="subdued">
              Cancel-flow save rate ({windowLabel})
            </Text>
            <Text as="p" variant="headingLg">
              {pctFrom01(overallSaveRate)}
            </Text>
            {overallSaveRate != null ? (
              <TargetBand
                value={overallSaveRate}
                targetMin={SAVE_TARGET.min}
                targetMax={SAVE_TARGET.max}
                scaleMax={1}
                accessibilityLabel="Save rate vs the 20 to 30 percent target"
              />
            ) : (
              <Text as="p" variant="bodySm" tone="subdued">
                Appears once subscribers have entered the cancel flow in this
                window.
              </Text>
            )}
            <Text as="p" variant="bodySm" tone="subdued">
              Cancel-flow sessions that ended with the subscriber staying. The
              healthy band is 20–30% — far above it usually means
              over-discounting.
            </Text>
          </BlockStack>
        </Card>
        <StatCard
          title={`Skip : cancel ratio (${windowLabel})`}
          value={
            funnel.skipToCancelRatio != null
              ? `${finite(funnel.skipToCancelRatio).toFixed(1)} : 1`
              : "—"
          }
          helpText="Skips per cancellation. Higher is healthier — skipping is a pressure valve that avoids churn. Below 1:1 means people quit rather than pause."
        />
        <StatCard
          title={`Add-ons per charge (${windowLabel})`}
          value={
            funnel.addonAttachRate != null
              ? finite(funnel.addonAttachRate).toFixed(2)
              : "—"
          }
          helpText="One-time add-ons attached per successful renewal charge (can exceed 1 when subscribers add several)."
        />
        <StatCard
          title="Prepaid mix (live)"
          value={pctFrom100(funnel.prepaidMixPct, 1)}
          helpText="Share of active subscribers on prepaid (bill once, ship several times) plans, right now."
        />
      </InlineGrid>

      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">
            Save rate by cancel reason ({windowLabel})
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            For each reason subscribers give when cancelling: how many sessions
            were started, and how many ended with the subscriber staying
            (accepting a skip, pause, discount or swap instead). Configure the
            offers shown per reason in the cancel flow.
          </Text>
          {saveRateRows.length === 0 ? (
            <Text as="p" variant="bodySm" tone="subdued">
              No cancel-flow sessions with a recorded reason in this window.
              Sessions appear here as soon as a subscriber starts a
              cancellation in the portal.
            </Text>
          ) : (
            <DataTable
              columnContentTypes={["text", "numeric", "numeric", "numeric", "text"]}
              headings={["Reason", "Sessions", "Saved", "Save rate", ""]}
              rows={saveRateRows}
            />
          )}
        </BlockStack>
      </Card>
    </BlockStack>
  );
}

// ── Cohorts & LTGP ────────────────────────────────────────────────────────────

type CohortMeasure = "retention" | "ltgpPerSub" | "cumLtgp";

const MEASURE_OPTIONS: { label: string; value: CohortMeasure }[] = [
  { label: "Retention %", value: "retention" },
  { label: "LTGP per subscriber", value: "ltgpPerSub" },
  { label: "Cumulative LTGP", value: "cumLtgp" },
];

function CohortsTab({ data }: { data: ReadyData }) {
  const {
    heatmap,
    ltgpRows,
    ltgpWeightedAvg,
    costCoverage,
    currencyCode,
    vatEnabled,
    excludeRefunded,
  } = data;
  const [measure, setMeasure] = useState<CohortMeasure>("retention");

  const heatmapRows: HeatmapRow[] = useMemo(() => {
    // Money measures normalize color against the largest |value| in view.
    let maxAbsMoney = 0;
    if (measure !== "retention") {
      for (const row of heatmap.rows) {
        for (const cell of row.cells) {
          const v =
            measure === "cumLtgp"
              ? cell.cumGrossProfitCents
              : row.cohortSize > 0
                ? cell.cumGrossProfitCents / row.cohortSize
                : 0;
          maxAbsMoney = Math.max(maxAbsMoney, Math.abs(finite(v)));
        }
      }
    }

    return heatmap.rows.map((row): HeatmapRow => {
      const monthLabel = monthKeyLabel(row.cohortMonth);
      const cellByOffset = new Map(row.cells.map((c) => [c.offset, c]));
      const cells: HeatmapCell[] = [];
      for (let offset = 0; offset <= heatmap.maxOffset; offset++) {
        const cell = cellByOffset.get(offset);
        if (!cell) {
          cells.push({ display: "", intensity: null });
          continue;
        }
        if (measure === "retention") {
          const fraction =
            row.cohortSize > 0 ? cell.activeRemaining / row.cohortSize : null;
          cells.push({
            display: fraction == null ? "—" : `${Math.round(finite(fraction) * 100)}%`,
            intensity: fraction == null ? null : Math.max(0, Math.min(1, finite(fraction))),
            inProgress: cell.inProgress,
            title:
              fraction == null
                ? undefined
                : `Of ${row.cohortSize} subscribers who started in ${monthLabel}, ` +
                  `${Math.round(finite(fraction) * 100)}% were still active ${offset} month${offset === 1 ? "" : "s"} later` +
                  (cell.inProgress ? " (month still in progress)" : "") +
                  ".",
          });
        } else {
          const cents =
            measure === "cumLtgp"
              ? cell.cumGrossProfitCents
              : row.cohortSize > 0
                ? Math.round(cell.cumGrossProfitCents / row.cohortSize)
                : null;
          const intensity =
            cents == null || maxAbsMoney === 0
              ? cents == null
                ? null
                : 0
              : Math.max(0, Math.min(1, Math.abs(cents) / maxAbsMoney));
          cells.push({
            display: cents == null ? "—" : compactMoney(cents, currencyCode),
            intensity,
            negative: cents != null && cents < 0,
            inProgress: cell.inProgress,
            title:
              cents == null
                ? undefined
                : `${monthLabel} cohort: ${formatMoney(cents, currencyCode)} cumulative gross profit ` +
                  `${measure === "ltgpPerSub" ? "per subscriber " : ""}by month ${offset}` +
                  (cell.inProgress ? " (month still in progress)" : "") +
                  ".",
          });
        }
      }
      return {
        label: monthLabel,
        sublabel: `${row.cohortSize.toLocaleString("en")} subscriber${row.cohortSize === 1 ? "" : "s"}`,
        cells,
      };
    });
  }, [heatmap, measure, currencyCode]);

  const columnLabels = Array.from({ length: heatmap.maxOffset + 1 }, (_, i) => `M${i}`);
  const legend =
    measure === "retention"
      ? { low: "0%", high: "100%" }
      : { low: compactMoney(0, currencyCode), high: "highest" };

  const money = (cents: number | null): string =>
    cents == null ? "—" : formatMoney(cents, currencyCode);

  const rows: ReactNode[][] = ltgpRows.map((c) => [
    monthKeyLabel(c.cohortMonth),
    c.cohortSize,
    money(c.ltgpM3Cents),
    money(c.totalM3Cents),
    money(c.ltgpM6Cents),
    money(c.totalM6Cents),
    money(c.ltgpM12Cents),
    money(c.totalM12Cents),
  ]);

  if (ltgpRows.length > 0) {
    rows.push([
      <Text as="span" fontWeight="semibold" key="wavg">
        Weighted average
      </Text>,
      "",
      <Text as="span" fontWeight="semibold" key="m3">
        {money(ltgpWeightedAvg.m3Cents)}
      </Text>,
      "",
      <Text as="span" fontWeight="semibold" key="m6">
        {money(ltgpWeightedAvg.m6Cents)}
      </Text>,
      "",
      <Text as="span" fontWeight="semibold" key="m12">
        {money(ltgpWeightedAvg.m12Cents)}
      </Text>,
      "",
    ]);
  }

  // The coverage stats describe the WHOLE billed book; under a segment
  // filter they can name products that are not even in the filtered
  // triangle, so the banner hides rather than mislabel the population.
  const showCostBanner =
    !data.segmentActive &&
    costCoverage.totalLines > 0 &&
    costCoverage.productsMissingCount > 0;

  return (
    <BlockStack gap="400">
      {showCostBanner && (
        <Banner
          tone="warning"
          title={`LTGP is partly estimated — ${costCoverage.productsMissingCount} product${
            costCoverage.productsMissingCount === 1 ? "" : "s"
          } missing costs`}
          action={{ content: "Set product costs", url: "/app/plans" }}
        >
          <p>
            Only {pctFrom100(costCoverage.linesWithKnownCogsPct)} of
            subscription lines ({pctFrom100(costCoverage.revenueWithKnownCogsPct)}{" "}
            of revenue) have a known product cost — the rest is estimated from
            the cost model&rsquo;s percentage fallback, so the gross-profit
            figures below are approximate.
            {costCoverage.sampleProductTitles.length > 0 &&
              ` Missing: ${costCoverage.sampleProductTitles.join(", ")}${
                costCoverage.productsMissingCount > costCoverage.sampleProductTitles.length
                  ? ", …"
                  : ""
              }.`}{" "}
            Set exact costs on the Plans page, or as &ldquo;Cost per
            item&rdquo; on the product in Shopify.
          </p>
        </Banner>
      )}

      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h3" variant="headingMd">
              Cohort performance by signup month
            </Text>
            <Box minWidth="220px">
              <Select
                label="Measure"
                labelHidden
                options={MEASURE_OPTIONS}
                value={measure}
                onChange={(v) => setMeasure(v as CohortMeasure)}
              />
            </Box>
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            {measure === "retention"
              ? "Share of each signup cohort still active N months after their first charge. Read down a column to compare cohorts at the same age."
              : measure === "ltgpPerSub"
                ? "Cumulative gross profit per subscriber, month by month. First (checkout) orders are included where their payment has been captured — the daily backfill fills older contracts in. This is the number to price acquisition against."
                : "Total cumulative gross profit per cohort (first orders included where captured, plus every renewal) — how much money each signup month has generated so far."}
          </Text>
          {heatmapRows.length === 0 ? (
            <Text as="p" variant="bodySm" tone="subdued">
              The cohort grid appears after the daily analytics job has run
              with at least one subscriber — it runs automatically overnight.
              Each row will be a signup month; each column, months since
              signup.
            </Text>
          ) : (
            <CohortHeatmap
              rows={heatmapRows}
              columnLabels={columnLabels}
              legendLow={legend.low}
              legendHigh={legend.high}
              accessibilityLabel="Cohort performance heatmap by signup month"
            />
          )}
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">
            Lifetime gross profit at 3 / 6 / 12 months
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            LTGP = payments actually collected
            {excludeRefunded
              ? " (fully and partially refunded payments excluded — Settings → Analytics data)"
              : " (net of refunds)"}{" "}
            − product COGS − shipping − payment processing fees
            {vatEnabled &&
              " − VAT (your per-country rate — default rate where unset — as a flat % of each charge)"}
            , accumulated by signup-month
            cohort. First (checkout) orders are included where their payment
            has been captured — new subscriptions are captured on arrival and
            a daily backfill fills older contracts in, so freshly upgraded
            books read slightly low until it completes. First-order COGS is
            approximated from the subscription&rsquo;s current items.
            &ldquo;/ sub&rdquo; divides by cohort size; a horizon shows —
            until the cohort has fully aged past it, so young cohorts never
            drag the averages down.
          </Text>
          {rows.length === 0 ? (
            <Text as="p" variant="bodySm" tone="subdued">
              No cohorts yet — this table fills in from the first subscriber
              cohort once the daily analytics job has run.
            </Text>
          ) : (
            <DataTable
              columnContentTypes={[
                "text",
                "numeric",
                "numeric",
                "numeric",
                "numeric",
                "numeric",
                "numeric",
                "numeric",
              ]}
              headings={[
                "Cohort",
                "Size",
                "M3 / sub",
                "M3 total",
                "M6 / sub",
                "M6 total",
                "M12 / sub",
                "M12 total",
              ]}
              rows={rows}
            />
          )}
        </BlockStack>
      </Card>

      <PredictedLtgpCard data={data} />
    </BlockStack>
  );
}

/**
 * Predicted LTGP (v1.21.0) — the forward-looking overlay on the actuals
 * above: average predicted cumulative gross profit per subscriber at fixed
 * horizons from signup, by signup-month cohort. Labels are local constants
 * (never import the .server module into a tab component — the ownership
 * shared.ts client-bundle rule).
 */
const PREDICTED_HORIZONS = [
  { key: "d90", label: "90d" },
  { key: "d180", label: "180d" },
  { key: "y1", label: "1y" },
  { key: "y3", label: "3y" },
  { key: "y5", label: "5y" },
] as const;

function PredictedLtgpCard({ data }: { data: ReadyData }) {
  const { predictedLtgp, currencyCode } = data;
  const money = (cents: number | null | undefined) =>
    cents == null ? "—" : formatMoney(cents, currencyCode);

  const maturedEntries = predictedLtgp
    ? PREDICTED_HORIZONS.flatMap(({ key, label }) => {
        const acc = predictedLtgp.accuracy.horizons[key];
        return acc && acc.matured > 0 && acc.mapePct != null
          ? [{ key, label, matured: acc.matured, mapePct: acc.mapePct, biasPct: acc.biasPct }]
          : [];
      })
    : [];

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingMd">
          Predicted LTGP — where the young cohorts are heading
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          Expected cumulative gross profit per subscriber at fixed horizons
          from signup, averaged per cohort over live predictions (recomputed
          nightly: the store&rsquo;s retention curve, each subscriber&rsquo;s
          risk score — survey answers included — and their current per-cycle
          margin). Unlike the actuals above, these are forecasts: short
          horizons firm up first, and 3y/5y on a young store are directional
          only. Each subscriber&rsquo;s day-one prediction is frozen and later
          compared against what really happened — the accuracy line below
          appears once the first cohorts mature, and stays honest because
          matured predictions are never rewritten.
        </Text>
        {!predictedLtgp || predictedLtgp.overall.contracts === 0 ? (
          <Text as="p" variant="bodySm" tone="subdued">
            No predictions yet — they appear after the nightly analytics job
            first scores active subscriptions.
          </Text>
        ) : (
          <>
            <DataTable
              columnContentTypes={[
                "text",
                "numeric",
                "numeric",
                "numeric",
                "numeric",
                "numeric",
                "numeric",
              ]}
              headings={[
                "Cohort",
                "Scored",
                ...PREDICTED_HORIZONS.map((h) => `${h.label} / sub`),
              ]}
              rows={[
                ...predictedLtgp.cohorts.map((cohort) => [
                  cohort.cohortMonth,
                  cohort.contracts.toLocaleString("en"),
                  ...PREDICTED_HORIZONS.map(({ key }) =>
                    money(cohort.avgCents[key]),
                  ),
                ]),
                [
                  <Text as="span" fontWeight="semibold" key="all">
                    All scored
                  </Text>,
                  <Text as="span" fontWeight="semibold" key="count">
                    {predictedLtgp.overall.contracts.toLocaleString("en")}
                  </Text>,
                  ...PREDICTED_HORIZONS.map(({ key }) => (
                    <Text as="span" fontWeight="semibold" key={key}>
                      {money(predictedLtgp.overall.avgCents[key])}
                    </Text>
                  )),
                ],
              ]}
            />
            {maturedEntries.length > 0 ? (
              <Text as="p" variant="bodySm" tone="subdued">
                Prediction accuracy so far (day-one predictions vs matured
                actuals):{" "}
                {maturedEntries
                  .map(
                    (e) =>
                      `${e.label}: ±${e.mapePct}% over ${e.matured} subscriber${e.matured === 1 ? "" : "s"}${
                        e.biasPct != null && Math.abs(e.biasPct) >= 1
                          ? ` (${e.biasPct > 0 ? "over" : "under"}-promising ${Math.abs(e.biasPct)}%)`
                          : ""
                      }`,
                  )
                  .join(" · ")}
              </Text>
            ) : (
              <Text as="p" variant="bodySm" tone="subdued">
                No matured predictions to grade yet — the first accuracy
                readings appear once day-one-scored subscribers pass their
                90-day mark.
              </Text>
            )}
          </>
        )}
      </BlockStack>
    </Card>
  );
}

// ── Survival & churn ──────────────────────────────────────────────────────────

function SurvivalTab({ data }: { data: ReadyData }) {
  const { survival, churnSplit, decidedContracts, segmentChurnSeries } = data;

  const toPoints = (fractions: number[]) =>
    survival.cycles.map((cycle, i) => ({ cycle, pct: fractions[i] ?? 0 }));

  // Plain-English takeaway: where is the steepest drop?
  const takeaway = useMemo(() => {
    if (survival.overall.length === 0) return null;
    let worstCycle = 1;
    let worstDrop = 1 - finite(survival.overall[0], 1);
    for (let i = 1; i < survival.overall.length; i++) {
      const drop = finite(survival.overall[i - 1]) - finite(survival.overall[i]);
      if (drop > worstDrop) {
        worstDrop = drop;
        worstCycle = i + 1;
      }
    }
    if (worstDrop <= 0) return null;
    return {
      cycle: worstCycle,
      dropPct: Math.round(worstDrop * 100),
    };
  }, [survival]);

  const tooEarly = decidedContracts < SURVIVAL_MIN_DECIDED;

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">
            Survival by order number (lifetime)
          </Text>
          {tooEarly ? (
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" tone="subdued">
                Too early to measure. Only{" "}
                {decidedContracts.toLocaleString("en")} subscriber
                {decidedContracts === 1 ? " has" : "s have"} either churned or
                renewed at least once — survival curves need at least{" "}
                {SURVIVAL_MIN_DECIDED} to mean anything. Right now most of your
                book simply hasn&rsquo;t reached its second order yet, which a
                curve would misread as churn.
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                What will appear here: the share of subscribers still active at
                each order (1st, 2nd, 3rd …), split into voluntary
                cancellations vs failed payments — so you can see exactly at
                which renewal people leave, and why.
              </Text>
            </BlockStack>
          ) : (
            <>
              <Text as="p" variant="bodySm" tone="subdued">
                Share of all {survival.totalContracts.toLocaleString("en")}{" "}
                subscribers (all time) still active at each order. The
                voluntary and involuntary curves each count only that churn
                cause as a loss — the gap below 100% is that cause&rsquo;s
                cumulative damage. Note: active subscribers who haven&rsquo;t
                reached an order yet count as not surviving to it, so a young
                book understates deep-order survival.
              </Text>
              <SurvivalCurve
                series={[
                  {
                    name: "Overall",
                    points: toPoints(survival.overall),
                    color: CHART_COLORS.primary,
                  },
                  {
                    name: "Voluntary churn only",
                    points: toPoints(survival.voluntary),
                    color: CHART_COLORS.caution,
                  },
                  {
                    name: "Involuntary churn only",
                    points: toPoints(survival.involuntary),
                    color: CHART_COLORS.critical,
                  },
                ]}
                height={280}
                xAxisLabel="Order number"
                accessibilityLabel="Subscriber survival by order number, split by churn cause"
              />
              {takeaway && (
                <Text as="p" variant="bodySm">
                  <Text as="span" fontWeight="semibold">
                    What this means:
                  </Text>{" "}
                  the steepest drop ({takeaway.dropPct} points) happens at
                  order {takeaway.cycle} — save offers, gifts and check-in
                  emails around that renewal have the most leverage.
                </Text>
              )}
            </>
          )}
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">
            Churn split (all time)
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Cancelled contracts by cause. Involuntary churn is cancelled by the
            dunning engine after payment retries were exhausted — fix it with
            better dunning, not save offers. System cancels are internal or
            unattributed; consolidation merges are excluded entirely (the
            customer stayed).
          </Text>
          <SplitBar
            segments={[
              {
                label: "Voluntary",
                value: churnSplit.voluntaryChurn,
                color: CHART_COLORS.caution,
              },
              {
                label: "Involuntary",
                value: churnSplit.involuntaryChurn,
                color: CHART_COLORS.critical,
              },
              ...(churnSplit.systemChurn > 0
                ? [
                    {
                      label: "System / other",
                      value: churnSplit.systemChurn,
                      color: CHART_COLORS.axis,
                    },
                  ]
                : []),
            ]}
            accessibilityLabel="Churn split by cause"
          />
          {churnSplit.voluntaryChurn + churnSplit.involuntaryChurn + churnSplit.systemChurn ===
            0 && (
            <Text as="p" variant="bodySm" tone="subdued">
              No churn recorded yet — that&rsquo;s the best possible version of
              this chart.
            </Text>
          )}
        </BlockStack>
      </Card>

      {segmentChurnSeries != null && (
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              Weekly arrivals vs churn (filtered, last{" "}
              {segmentChurnSeries.weeks.length} weeks)
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              New subscribers, voluntary churn (chosen cancels and completed
              bounded plans) and involuntary churn (payment failure) in this
              segment, per week — computed live from contract records.
            </Text>
            <DataTable
              columnContentTypes={["text", "numeric", "numeric", "numeric"]}
              headings={["Week", "New", "Voluntary churn", "Involuntary churn"]}
              rows={segmentChurnSeries.weeks.map((week, i) => [
                dateKeyLabel(week),
                segmentChurnSeries.newSubscribers[i] ?? 0,
                segmentChurnSeries.churnedVoluntary[i] ?? 0,
                segmentChurnSeries.churnedInvoluntary[i] ?? 0,
              ])}
            />
          </BlockStack>
        </Card>
      )}
    </BlockStack>
  );
}

// ── Forecast ──────────────────────────────────────────────────────────────────

interface SerializedMetricSeries {
  history: { weekStartIso: string; value: number }[];
  forecast: { weekStartIso: string; value: number; lo: number; hi: number }[];
  filledWeeks: string[];
}

function toForecastChartData(metric: SerializedMetricSeries) {
  return {
    history: metric.history.map((p) => ({
      label: dateKeyLabel(p.weekStartIso),
      value: p.value,
    })),
    forecast: metric.forecast.map((p) => ({
      label: dateKeyLabel(p.weekStartIso),
      value: p.value,
    })),
    band: {
      upper: metric.forecast.map((p) => p.hi),
      lower: metric.forecast.map((p) => p.lo),
    },
  };
}

function ForecastTab({ data }: { data: ReadyData }) {
  const [, setSearchParams] = useSearchParams();
  const { forecast, currencyCode } = data;
  const { accuracy, models, legacyModel } = forecast;

  const setParam = useCallback(
    (key: string) => (value: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set(key, value);
          next.set("tab", "forecast");
          return next;
        },
        { preventScrollReset: true },
      );
    },
    [setSearchParams],
  );

  const selectedReport = models.find((m) => m.key === forecast.selectedModel);
  const selectedLabel = selectedReport?.label ?? forecast.selectedModel;
  const grade = accuracy.grade;

  const modelOptions = [
    {
      label: `Auto — best available model (currently: ${selectedLabel})`,
      value: "auto",
    },
    ...models.map((m) => ({
      label: m.available
        ? m.label
        : `${m.label} — needs ${m.minWeeksRequired} weeks of data`,
      value: m.key,
      disabled: !m.available,
    })),
  ];

  // Segment forecasts carry no MRR series (per-segment MRR history cannot be
  // reconstructed) — the MRR chart gives way to an explanation then.
  const mrr = forecast.metrics.mrrCents
    ? toForecastChartData(forecast.metrics.mrrCents)
    : null;
  const actives = toForecastChartData(forecast.metrics.activeSubscribers);
  const netRevenue = toForecastChartData(forecast.metrics.netRevenueCents);
  const weeksOfHistory = forecast.metrics.activeSubscribers.history.length;
  const filledCount = (forecast.metrics.mrrCents ?? forecast.metrics.activeSubscribers)
    .filledWeeks.length;

  const backtestRows = models.map((m) => [
    m.label,
    m.available
      ? m.backtestMape != null
        ? pctFrom01(m.backtestMape)
        : "—"
      : "—",
    m.available
      ? m.backtestBias != null
        ? `${m.backtestBias > 0 ? "runs high" : m.backtestBias < 0 ? "runs low" : "unbiased"}`
        : "—"
      : `needs ${m.minWeeksRequired} wks`,
    m.recommended ? (
      <Text as="span" key={m.key} fontWeight="semibold" tone="success">
        Recommended
      </Text>
    ) : (
      ""
    ),
  ]);

  return (
    <BlockStack gap="400">
      <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
        <Select
          label="Model"
          options={modelOptions}
          value={forecast.requestedModel}
          onChange={setParam("model")}
          helpText="Auto picks the model with the best backtest for your data. Models needing more history unlock over time."
        />
        <Select
          label="Horizon"
          options={HORIZON_OPTIONS.map((w) => ({
            label: `${w} weeks`,
            value: String(w),
          }))}
          value={String(forecast.horizonWeeks)}
          onChange={setParam("horizon")}
          helpText="Longer horizons compound uncertainty — the shaded band widens accordingly."
        />
      </InlineGrid>

      <Text as="p" variant="bodySm" tone="subdued">
        {data.segmentActive
          ? "Filtered view — this forecast runs the same models over history reconstructed live for the segment; the store-wide recorded accuracy history does not apply to it."
          : forecast.modelHistory.weeksRecorded > 0
            ? `Each week the models' backtest errors are recorded (${forecast.modelHistory.weeksRecorded} week${
                forecast.modelHistory.weeksRecorded === 1 ? "" : "s"
              } on record so far), and auto-selection weighs recent weeks more — so the model choice keeps improving as history accumulates.`
            : "No recorded accuracy history yet — auto-selection uses the current backtest alone. The nightly analytics job starts recording each week's model errors from here, and the choice improves as that history accumulates."}
      </Text>

      {mrr ? (
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              MRR — observed and projected
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Weekly MRR snapshots (solid, filled markers) with a{" "}
              {forecast.horizonWeeks}-week projection (dashed, hollow markers).
              The shaded band is the ~80% likely range.
            </Text>
            <ForecastChart
              history={mrr.history}
              forecast={mrr.forecast}
              band={mrr.band}
              modelLabel={selectedLabel}
              accuracyGrade={grade}
              height={260}
              formatValue={(v) => compactMoney(v, currencyCode)}
              accessibilityLabel={`Observed weekly MRR with a ${forecast.horizonWeeks}-week projection`}
            />
            {filledCount > 0 && (
              <Text as="p" variant="bodySm" tone="subdued">
                {filledCount} week{filledCount === 1 ? " was" : "s were"} filled
                by carrying the previous value forward (no analytics rollup ran
                those weeks).
              </Text>
            )}
          </BlockStack>
        </Card>
      ) : (
        <Card>
          <BlockStack gap="200">
            <Text as="h3" variant="headingMd">
              MRR — not available in filtered views
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              MRR history for a segment cannot be reconstructed after the fact
              (past prices and cadences are not recorded per week), so the
              filtered forecast covers active subscribers and collected
              revenue below — both rebuilt live from this segment&rsquo;s
              contracts and orders.
            </Text>
          </BlockStack>
        </Card>
      )}

      <InlineGrid columns={{ xs: 1, lg: 2 }} gap="400">
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              Active subscribers
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Projection includes churn only — new-subscriber inflow is
              deliberately excluded, so the dashed line is the floor if
              acquisition stopped today, not a prediction of decline.
            </Text>
            <ForecastChart
              history={actives.history}
              forecast={actives.forecast}
              band={actives.band}
              accuracyGrade={grade}
              height={240}
              color={CHART_COLORS.primary}
              formatValue={compactNumber}
              accessibilityLabel={`Observed weekly active subscribers with a ${forecast.horizonWeeks}-week projection`}
            />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              Collected revenue per week
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Actual weekly payments collected (net of refunds), observed and
              projected — this is cash, where MRR is the normalized run rate.
            </Text>
            <ForecastChart
              history={netRevenue.history}
              forecast={netRevenue.forecast}
              band={netRevenue.band}
              accuracyGrade={grade}
              height={240}
              color={CHART_COLORS.success}
              formatValue={(v) => compactMoney(v, currencyCode)}
              accessibilityLabel={`Observed weekly collected revenue with a ${forecast.horizonWeeks}-week projection`}
            />
          </BlockStack>
        </Card>
      </InlineGrid>

      <InlineGrid columns={{ xs: 1, lg: 2 }} gap="400">
        <Card>
          <BlockStack gap="200">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h3" variant="headingMd">
                How much to trust this
              </Text>
              <AccuracyGradeChip grade={grade} />
            </InlineStack>
            {accuracy.reasons.length > 0 ? (
              <List type="bullet">
                {accuracy.reasons.map((reason) => (
                  <List.Item key={reason}>{reason}</List.Item>
                ))}
              </List>
            ) : (
              <Text as="p" variant="bodySm" tone="subdued">
                {accuracy.label}
              </Text>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h3" variant="headingMd">
              Model details
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {legacyModel != null
                ? `Selected model: ${selectedLabel} over ${weeksOfHistory} week${
                    weeksOfHistory === 1 ? "" : "s"
                  } of weekly history. Subscriber decay uses a per-cycle survival estimate of ${(
                    finite(legacyModel.avgCycleSurvival) * 100
                  ).toFixed(1)}% (≈ ${(
                    finite(legacyModel.weeklyRetention) * 100
                  ).toFixed(2)}% weekly at the average ${finite(
                    legacyModel.avgIntervalWeeks,
                  )}-week billing interval). When too few renewals have been observed, a conservative default stands in — the trust card on the left reflects exactly how solid these inputs are.`
                : `Selected model: ${selectedLabel} over ${weeksOfHistory} week${
                    weeksOfHistory === 1 ? "" : "s"
                  } of weekly history reconstructed for this segment. Subscriber decay uses the segment's own censoring-corrected per-cycle survival; when too few of its renewals have been observed, a conservative default stands in — the trust card on the left reflects exactly how solid these inputs are.`}
            </Text>
          </BlockStack>
        </Card>
      </InlineGrid>

      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">
            Backtest — how each model would have done
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Each model is replayed on past weeks and its projections compared
            with what actually happened (walk-forward error; lower is better).
            &ldquo;Runs high/low&rdquo; shows the model&rsquo;s systematic
            direction of error.
          </Text>
          <DataTable
            columnContentTypes={["text", "numeric", "text", "text"]}
            headings={["Model", "Backtest error", "Bias", ""]}
            rows={backtestRows}
          />
        </BlockStack>
      </Card>
    </BlockStack>
  );
}
