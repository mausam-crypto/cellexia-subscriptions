/**
 * Executive dashboard [analytics/dashboard] — ANALYTICS-V2 §3.
 *
 * Insight strip first, then the Continuous Treatment KPI set grouped under
 * Growth / Revenue & profit / Retention / Payment recovery, the 13-week
 * forecast with its reliability chip, the survival curve and the voluntary
 * vs payment-related churn split.
 *
 * Honesty rules baked into this page:
 * - Point-in-time tiles never show a fake "Steady" badge. Where history is
 *   reconstructable (active plans, from createdAt/cancelledAt/pausedUntil)
 *   the badge uses the reconstruction; where it is not (money at historical
 *   prices, lifetime LTV), the badge is removed entirely.
 * - Forecast charts run over a DENSE week axis — zero weeks render as zero.
 * - Week labels are formatted from the ISO date string, never via local
 *   Date parsing (no timezone drift).
 * - 0/0 survival checkpoints are dropped, not rendered as 0%.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, useSearchParams } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  Tooltip,
} from "@shopify/polaris";
import type { BadgeProps, BoxProps } from "@shopify/polaris";
import { useState } from "react";
import type { ReactNode } from "react";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { requireRole } from "~/services/core/rbac.server";
import { isRoleAllowed } from "~/services/core/pure";
import { addDays, isoDate } from "~/lib/dates";
import { parseJson } from "~/types/domain";
import {
  getExecutiveMetrics,
  getSurvivalCurves,
  safeRate,
} from "~/services/analytics/metrics.server";
import type { ExecutiveMetrics } from "~/services/analytics/metrics.server";
import {
  computeReliabilityInputs,
  forecastReliability,
} from "~/services/analytics/forecast.server";
import { getCostModel } from "~/services/analytics/costModel.server";
import { bestConfigurations } from "~/services/analytics/cohorts.server";
import {
  aggregateForecastWeeks,
  buildInsights,
  extractForecastRows,
  measurableSurvival,
  reconstructActiveCount,
} from "~/services/analytics/insights.server";
import type { Insight } from "~/services/analytics/insights.server";
import {
  fmtDateLabel,
  fmtDelta,
  fmtMoney,
  fmtNumber,
  fmtPct,
} from "~/components/charts/format";
import type { DeltaFormat } from "~/components/charts/format";
import { LineChart } from "~/components/charts/LineChart";
import { BarChart } from "~/components/charts/BarChart";
import { SurvivalChart } from "~/components/charts/SurvivalChart";
import { Sparkline } from "~/components/charts/Sparkline";

const RANGE_OPTIONS = [30, 90, 365] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  // RBAC (SAFEGUARDS.md §5): every admin loader enforces its own roles —
  // parent loaders run in parallel and cannot gate children. The executive
  // dashboard is OWNER/ADMIN/ANALYST; CS_AGENT is REDIRECTED to the
  // subscriber console — this is the app's landing route ("/app"), and a
  // thrown 403 here bubbles to app.tsx's ErrorBoundary, wiping the NavMenu
  // and stranding CS_AGENT with no way into the pages their role allows.
  const { role } = await requireRole(session);
  if (role === "CS_AGENT") throw redirect("/app/subscribers");
  // Explicit dashboard gate so future roles never silently gain access.
  if (!isRoleAllowed(role, ["OWNER", "ADMIN", "ANALYST"])) {
    throw new Response("Forbidden: your role does not permit this action", {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }
  const shop = session.shop;

  const url = new URL(request.url);
  const requested = Number(url.searchParams.get("range") ?? "90");
  const rangeDays = (RANGE_OPTIONS as readonly number[]).includes(requested)
    ? requested
    : 90;

  const to = new Date();
  const from = addDays(to, -rangeDays);
  const prevFrom = addDays(from, -rangeDays);

  const [
    current,
    previousRaw,
    survivalCurves,
    snapshot,
    costModel,
    reliabilityInputs,
    bestConfigs,
    contractRows,
  ] = await Promise.all([
    getExecutiveMetrics(shop, { from, to }),
    getExecutiveMetrics(shop, { from: prevFrom, to: from }),
    getSurvivalCurves(shop),
    prisma.forecastSnapshot.findFirst({
      where: { shop },
      orderBy: { computedAt: "desc" },
    }),
    getCostModel(shop),
    computeReliabilityInputs(shop),
    bestConfigurations(shop, 1),
    prisma.subscriptionContract.findMany({
      where: { shop },
      select: {
        createdAt: true,
        cancelledAt: true,
        status: true,
        pausedUntil: true,
      },
    }),
  ]);

  const reliability = forecastReliability(reliabilityInputs);

  // Honest point-in-time trend: reconstruct the subscriber base at each
  // period boundary (the stored point-in-time metrics are computed from
  // current DB state only, so comparing them to "previous" is comparing a
  // value to itself).
  const activeAtFrom = reconstructActiveCount(contractRows, from, to);
  const activeAtTo = reconstructActiveCount(contractRows, to, to);

  // The service divides the previous window's PRODUCT_ADDED count by
  // TODAY's active base; rebase the previous rate on the base as of that
  // window's end so a growing shop cannot manufacture a fake improvement.
  const previous: ExecutiveMetrics = {
    ...previousRaw,
    productAdditionRate: safeRate(
      previousRaw.counts.productsAdded,
      Math.max(activeAtFrom, 1),
    ),
  };

  const insights = buildInsights(current, previous, {
    reliability,
    costModel,
    bestConfig: bestConfigs[0],
  });

  const rows = extractForecastRows(
    parseJson<unknown>(snapshot?.rowsJson ?? null, null),
  );
  const forecastWeeks = snapshot
    ? aggregateForecastWeeks(
        rows,
        snapshot.computedAt,
        snapshot.horizonWeeks,
      ).map((w) => ({
        ...w,
        // Label from the ISO string itself — `new Date("2026-08-03")` is UTC
        // midnight and renders as the previous day west of UTC.
        label: fmtDateLabel(w.weekStart),
      }))
    : [];

  const all = survivalCurves.find((c) => c.cohort === "all") ?? null;

  const costConfigured =
    (current as ExecutiveMetrics & { costConfigured?: boolean })
      .costConfigured ?? costModel.configured;

  return json({
    rangeDays,
    current,
    previous,
    insights,
    reliability,
    costConfigured,
    activeAtFrom,
    activeAtTo,
    forecastWeeks,
    // Formatted server-side from the UTC date string so SSR, hydration and
    // the forecast tab all agree.
    forecastComputedAtLabel: snapshot
      ? fmtDateLabel(isoDate(snapshot.computedAt))
      : null,
    // 0/0 checkpoints removed; null when nothing is measurable yet.
    survival: measurableSurvival(all),
  });
};

// ── Metric tiles ─────────────────────────────────────────────────────────

type NumericMetricKey = {
  [K in keyof ExecutiveMetrics]-?: ExecutiveMetrics[K] extends number ? K : never;
}[keyof ExecutiveMetrics];

type TileFormat = DeltaFormat;

interface TileDef {
  key: NumericMetricKey;
  label: string;
  format: TileFormat;
  /** Business direction: is an increase good for the merchant? */
  goodWhenUp: boolean;
  /** Plain-language "How this is computed" shown in a tooltip. */
  helpText: string;
  /**
   * How the period-over-period badge is produced:
   * - "range": both periods are honestly range-scoped — compare directly.
   * - "reconstructed": point-in-time metric whose history is reconstructed
   *   from createdAt/cancelledAt/pausedUntil.
   * - "none": point-in-time metric that CANNOT be reconstructed — no badge
   *   at all rather than a fake "Steady".
   */
  delta: "range" | "reconstructed" | "none";
  /** Hide the badge when either period's value is 0 (metric undefined). */
  deltaGuard?: "bothNonZero";
}

interface TileSection {
  title: string;
  tiles: TileDef[];
}

const TILE_SECTIONS: TileSection[] = [
  {
    title: "Growth",
    tiles: [
      {
        key: "activeSubscribers",
        label: "Active treatment plans",
        format: "count",
        goodWhenUp: true,
        delta: "reconstructed",
        helpText:
          "How this is computed: plans whose status is ACTIVE right now. The trend badge compares plans that existed and were not cancelled at the end of this period vs the end of the period before (past pause states cannot be reconstructed).",
      },
      {
        key: "newSubscriptions",
        label: "New plans started",
        format: "count",
        goodWhenUp: true,
        delta: "range",
        helpText:
          "How this is computed: plans created during the selected period.",
      },
      {
        key: "netGrowth",
        label: "Net growth",
        format: "count",
        goodWhenUp: true,
        delta: "range",
        helpText:
          "How this is computed: new plans started minus plans cancelled in the selected period.",
      },
      {
        key: "widgetConversionRate",
        label: "Widget conversion",
        format: "rate",
        goodWhenUp: true,
        delta: "range",
        helpText:
          "How this is computed: widget conversions divided by widget impressions in the selected period.",
      },
      {
        key: "attachRate",
        label: "Plan attach rate",
        format: "rate",
        goodWhenUp: true,
        delta: "range",
        helpText:
          "How this is computed: widget conversions that selected a subscription, divided by all widget conversions in the period.",
      },
      {
        key: "oneTimeToSubscriptionRate",
        label: "One-time to plan conversion",
        format: "rate",
        goodWhenUp: true,
        delta: "range",
        helpText:
          "How this is computed: conversions of the post-purchase switch-to-a-plan widget divided by its impressions in the period.",
      },
    ],
  },
  {
    title: "Revenue & profit",
    tiles: [
      {
        key: "activeSubscriptionRevenueCents",
        label: "Recurring revenue / cycle",
        format: "cents",
        goodWhenUp: true,
        delta: "none",
        helpText:
          "How this is computed: the sum of every active plan's current line prices for one billing cycle. Snapshot of right now — historical prices are not stored, so no period comparison is shown.",
      },
      {
        key: "recurringGrossProfitCents",
        label: "Recurring gross profit / cycle",
        format: "cents",
        goodWhenUp: true,
        delta: "none",
        helpText:
          "How this is computed: per-cycle recurring revenue minus product costs (COGS) from your cost model. Snapshot of right now, so no period comparison is shown.",
      },
      {
        key: "contributionCents",
        label: "Contribution / cycle",
        format: "cents",
        goodWhenUp: true,
        delta: "none",
        helpText:
          "How this is computed: per-cycle revenue minus COGS, shipping, fulfilment and payment fees from your cost model. Snapshot of right now, so no period comparison is shown.",
      },
      {
        key: "subscriberAovCents",
        label: "Subscriber AOV",
        format: "cents",
        goodWhenUp: true,
        delta: "range",
        deltaGuard: "bothNonZero",
        helpText:
          "How this is computed: the average value of successful charges in the selected period. Before any billing history exists it falls back to the average per-cycle plan value; the comparison is hidden when either period had no charges.",
      },
      {
        key: "grossMarginLtvCents",
        label: "Gross-margin LTV (avg)",
        format: "cents",
        goodWhenUp: true,
        delta: "none",
        helpText:
          "How this is computed: average lifetime revenue per billed plan multiplied by its gross-margin fraction. A lifetime figure has no honest previous-period value, so no comparison is shown.",
      },
      {
        key: "paidOrdersPerSubscriber",
        label: "Paid orders / subscriber",
        format: "decimal",
        goodWhenUp: true,
        delta: "range",
        helpText:
          "How this is computed: successful charges up to each period's end divided by plans created up to that point.",
      },
    ],
  },
  {
    title: "Retention",
    tiles: [
      {
        key: "voluntaryChurnRate",
        label: "Voluntary churn",
        format: "rate",
        goodWhenUp: false,
        delta: "range",
        helpText:
          "How this is computed: completed customer cancellations in the period divided by the subscriber base at the period start. Down is good — a falling rate shows a green badge.",
      },
      {
        key: "pauseRate",
        label: "Pause rate",
        format: "rate",
        goodWhenUp: false,
        delta: "range",
        helpText:
          "How this is computed: pauses started in the period divided by the subscriber base at the period start. Down is good.",
      },
      {
        key: "reactivationRate",
        label: "Reactivation rate",
        format: "rate",
        goodWhenUp: true,
        delta: "range",
        helpText:
          "How this is computed: paused plans that resumed divided by pauses started in the period.",
      },
      {
        key: "skipRate",
        label: "Skip rate",
        format: "rate",
        goodWhenUp: false,
        delta: "range",
        helpText:
          "How this is computed: skipped orders divided by skipped plus completed charges in the period. Down is good.",
      },
      {
        key: "productAdditionRate",
        label: "Product addition rate",
        format: "rate",
        goodWhenUp: true,
        delta: "range",
        helpText:
          "How this is computed: products added to existing plans in the period divided by the active base at that period's end.",
      },
      {
        key: "subscriptionToRoutineRate",
        label: "Plan to routine rate",
        format: "rate",
        goodWhenUp: true,
        delta: "none",
        helpText:
          "How this is computed: the share of active plans holding two or more distinct products. Snapshot of right now, so no period comparison is shown.",
      },
    ],
  },
  {
    title: "Payment recovery",
    tiles: [
      {
        key: "involuntaryChurnRate",
        label: "Payment-related churn",
        format: "rate",
        goodWhenUp: false,
        delta: "range",
        helpText:
          "How this is computed: plans lost to payment failure (dunning exhausted) in the period divided by the subscriber base at the period start. Down is good.",
      },
      {
        key: "paymentRecoveryRate",
        label: "Payment recovery rate",
        format: "rate",
        goodWhenUp: true,
        delta: "range",
        helpText:
          "How this is computed: failed charges recovered by dunning retries divided by failed charges in the period.",
      },
    ],
  },
];

const EMPTY_CHART_TEXT = "Data appears after your first rebills.";

const INSIGHT_STYLES: Record<
  Insight["tone"],
  {
    badgeTone: BadgeProps["tone"];
    badgeLabel: string;
    background: BoxProps["background"];
  }
> = {
  positive: {
    badgeTone: "success",
    badgeLabel: "Win",
    background: "bg-surface-success",
  },
  warning: {
    badgeTone: "warning",
    badgeLabel: "Watch",
    background: "bg-surface-warning",
  },
  neutral: {
    badgeTone: "info",
    badgeLabel: "Note",
    background: "bg-surface-info",
  },
};

const RELIABILITY_TONES: Record<
  "LOW" | "MODERATE" | "HIGH",
  BadgeProps["tone"]
> = {
  LOW: "warning",
  MODERATE: "attention",
  HIGH: "success",
};

function formatMetric(
  value: number,
  format: TileFormat,
  currencyCode: string,
): string {
  switch (format) {
    case "cents":
      return fmtMoney(value, currencyCode);
    case "rate":
      return fmtPct(value);
    case "decimal":
      return value.toFixed(2);
    case "count":
      return String(Math.round(value));
  }
}

function DeltaBadge({
  value,
  previous,
  format,
  goodWhenUp,
  currencyCode,
}: {
  value: number;
  previous: number;
  format: TileFormat;
  goodWhenUp: boolean;
  currencyCode: string;
}) {
  const delta = value - previous;
  const negligible =
    format === "rate" ? Math.abs(delta) < 0.0005 : Math.abs(delta) < 0.005;
  if (!Number.isFinite(delta) || negligible) {
    return <Badge>Steady</Badge>;
  }
  // Tone follows the BUSINESS direction: voluntary churn falling is green.
  const good = (delta > 0) === goodWhenUp;
  return (
    <Badge tone={good ? "success" : "critical"}>
      {fmtDelta(delta, format, currencyCode)}
    </Badge>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────

export default function ExecutiveDashboard() {
  const data = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const [costsBannerDismissed, setCostsBannerDismissed] = useState(false);

  const current = data.current as unknown as ExecutiveMetrics;
  const previous = data.previous as unknown as ExecutiveMetrics;
  const currencyCode = current.currencyCode;
  const reliabilityGrade = data.reliability.grade as
    | "LOW"
    | "MODERATE"
    | "HIGH";

  const revenueSpark = data.forecastWeeks.map((w) => w.marginCents);

  function tileBadge(tile: TileDef): ReactNode {
    if (tile.delta === "none") return null;
    if (tile.delta === "reconstructed") {
      return (
        <DeltaBadge
          value={data.activeAtTo}
          previous={data.activeAtFrom}
          format="count"
          goodWhenUp={tile.goodWhenUp}
          currencyCode={currencyCode}
        />
      );
    }
    if (
      tile.deltaGuard === "bothNonZero" &&
      (current[tile.key] === 0 || previous[tile.key] === 0)
    ) {
      return null;
    }
    return (
      <DeltaBadge
        value={current[tile.key]}
        previous={previous[tile.key]}
        format={tile.format}
        goodWhenUp={tile.goodWhenUp}
        currencyCode={currencyCode}
      />
    );
  }

  return (
    <Page
      title="Continuous Treatment overview"
      subtitle={`Rates cover the last ${data.rangeDays} days, compared with the ${data.rangeDays} days before.`}
    >
      <Layout>
        {data.insights.length > 0 ? (
          <Layout.Section>
            <InlineGrid columns={{ xs: 1, md: 2, lg: 3 }} gap="300">
              {data.insights.map((insight, index) => {
                const style =
                  INSIGHT_STYLES[insight.tone as Insight["tone"]] ??
                  INSIGHT_STYLES.neutral;
                return (
                  <Box
                    key={`${index}-${insight.headline}`}
                    background={style.background}
                    padding="400"
                    borderRadius="300"
                  >
                    <BlockStack gap="150">
                      <InlineStack gap="200" blockAlign="center">
                        <Badge tone={style.badgeTone}>{style.badgeLabel}</Badge>
                        <Text as="h3" variant="headingSm">
                          {insight.headline}
                        </Text>
                      </InlineStack>
                      {insight.detail ? (
                        <Text as="p" variant="bodySm" tone="subdued">
                          {insight.detail}
                        </Text>
                      ) : null}
                      {insight.linkTo ? (
                        <Box>
                          <Button url={insight.linkTo} variant="plain">
                            Take a look
                          </Button>
                        </Box>
                      ) : null}
                    </BlockStack>
                  </Box>
                );
              })}
            </InlineGrid>
          </Layout.Section>
        ) : null}

        {!data.costConfigured && !costsBannerDismissed ? (
          <Layout.Section>
            <Banner
              tone="warning"
              title="Profit metrics are estimates until you set your costs"
              action={{
                content: "Set up costs",
                url: "/app/analytics?tab=costs",
              }}
              onDismiss={() => setCostsBannerDismissed(true)}
            >
              <p>
                Recurring gross profit, contribution and LTV currently use the
                default margin. Add product costs, shipping, fulfilment and
                payment fees to see true profit.
              </p>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <InlineStack align="end">
            <Select
              label="Date range"
              labelHidden
              options={[
                { label: "Last 30 days", value: "30" },
                { label: "Last 90 days", value: "90" },
                { label: "Last 365 days", value: "365" },
              ]}
              value={String(data.rangeDays)}
              onChange={(value) => setSearchParams({ range: value })}
            />
          </InlineStack>
        </Layout.Section>

        {TILE_SECTIONS.map((section) => (
          <Layout.Section key={section.title}>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                {section.title}
              </Text>
              <InlineGrid columns={{ xs: 1, sm: 2, md: 3, lg: 4 }} gap="400">
                {section.tiles.map((tile) => {
                  const badge = tileBadge(tile);
                  return (
                    <Card key={tile.key}>
                      <BlockStack gap="150">
                        <Tooltip content={tile.helpText} width="wide">
                          <Text as="p" variant="bodySm" tone="subdued">
                            {tile.label}
                          </Text>
                        </Tooltip>
                        <Text as="p" variant="headingLg">
                          {formatMetric(
                            current[tile.key],
                            tile.format,
                            currencyCode,
                          )}
                        </Text>
                        {badge ? (
                          <InlineStack gap="200">{badge}</InlineStack>
                        ) : null}
                      </BlockStack>
                    </Card>
                  );
                })}
              </InlineGrid>
            </BlockStack>
          </Layout.Section>
        ))}

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center" wrap>
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    13-week outlook
                  </Text>
                  <Tooltip
                    width="wide"
                    content={
                      data.reliability.reasons.length > 0
                        ? data.reliability.reasons.join(" ")
                        : "Based on billing history depth, active base size, observed cancellations and cost coverage."
                    }
                  >
                    <Badge tone={RELIABILITY_TONES[reliabilityGrade]}>
                      {`Reliability: ${reliabilityGrade} (${data.reliability.expectedErrorBand})`}
                    </Badge>
                  </Tooltip>
                </InlineStack>
                <InlineStack gap="200" blockAlign="center">
                  {revenueSpark.length > 0 ? (
                    <Sparkline
                      values={revenueSpark}
                      title="Expected margin trend over the next 13 weeks"
                    />
                  ) : null}
                  <Text as="span" variant="bodySm" tone="subdued">
                    {data.forecastComputedAtLabel
                      ? `Snapshot ${data.forecastComputedAtLabel}`
                      : ""}
                  </Text>
                </InlineStack>
              </InlineStack>
              {data.forecastWeeks.length === 0 ? (
                <Banner tone="info" title="No forecast snapshot yet">
                  <p>
                    Run the forecast job (POST /jobs/forecast) to generate the
                    13-week outlook by week, product and market.
                  </p>
                </Banner>
              ) : (
                <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
                  <LineChart
                    title="Expected revenue by week"
                    description="Probability-adjusted recurring revenue for the next 13 weeks. Weeks in which nothing bills show as zero."
                    labels={data.forecastWeeks.map((w) => w.label)}
                    series={[
                      {
                        name: "Expected revenue",
                        values: data.forecastWeeks.map((w) => w.revenueCents),
                      },
                      {
                        name: "Expected margin",
                        values: data.forecastWeeks.map((w) => w.marginCents),
                      },
                    ]}
                    formatValue={(v) => fmtMoney(v, currencyCode)}
                    emptyText={EMPTY_CHART_TEXT}
                  />
                  <BarChart
                    title="Probability-adjusted units by week"
                    description="Expected units to fulfil per week, including add-ons. Weeks with no fulfilment show as zero."
                    labels={data.forecastWeeks.map((w) => w.label)}
                    values={data.forecastWeeks.map((w) => w.units)}
                    formatValue={fmtNumber}
                    emptyText={EMPTY_CHART_TEXT}
                  />
                </InlineGrid>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Plan survival
                </Text>
                {data.survival ? (
                  <SurvivalChart
                    title="Share of treatment plans remaining"
                    description="Remaining plans after each rebill and time checkpoint, split by exit type. Checkpoints no plan is old enough to reach are omitted."
                    points={data.survival.points
                      // null = no plan old enough to be observed there yet —
                      // omitted per the chart description, never drawn as 0%.
                      .filter((p) => p.remainingPercent !== null)
                      .map((p) => ({
                        label: p.label,
                        remainingPercent: p.remainingPercent ?? 0,
                        voluntaryExitPercent: p.voluntaryExitPercent ?? 0,
                        paymentFailureExitPercent: p.paymentFailureExitPercent ?? 0,
                      }))}
                    emptyText={EMPTY_CHART_TEXT}
                  />
                ) : (
                  <Text as="p" tone="subdued">
                    Not enough data yet — {EMPTY_CHART_TEXT.toLowerCase()}
                  </Text>
                )}
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Churn split
                </Text>
                <BarChart
                  title="Voluntary vs payment-related churn"
                  description="Churn rate in the selected range, split by cause."
                  labels={["Voluntary", "Payment-related"]}
                  values={[
                    Math.round(current.voluntaryChurnRate * 1000) / 10,
                    Math.round(current.involuntaryChurnRate * 1000) / 10,
                  ]}
                  formatValue={(v) => fmtPct(v / 100, 1)}
                  height={180}
                  emptyText={EMPTY_CHART_TEXT}
                />
                <Text as="p" variant="bodySm" tone="subdued">
                  {current.counts.voluntaryCancellations} voluntary cancellations
                  and {current.counts.involuntaryCancellations} payment-related
                  losses in the selected range.
                </Text>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Where to act next
              </Text>
              <InlineStack gap="300" wrap>
                <Button url="/app/retention">At-risk subscribers</Button>
                <Button url="/app/dunning">Payment recovery queue</Button>
                <Button url="/app/analytics" variant="primary">
                  Full analytics
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
