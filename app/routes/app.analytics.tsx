import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import type { LoaderFunctionArgs, SerializeFrom } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams } from "@remix-run/react";
import {
  BlockStack,
  Box,
  Card,
  DataTable,
  EmptyState,
  InlineGrid,
  InlineStack,
  Page,
  Select,
  Tabs,
  Text,
} from "@shopify/polaris";

import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import {
  getForecast,
  getFunnelMetrics,
  getLtgpSummary,
  getSurvivalByCycle,
} from "~/lib/analytics/index.server";
import { formatMoney } from "~/lib/money";
import {
  LineChart,
  SplitBar,
  StatCard,
  SurvivalCurve,
  CHART_COLORS,
  compactMoney,
  compactNumber,
  dateKeyLabel,
} from "~/components/charts";

const RANGE_OPTIONS = [30, 60, 90] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const rangeParam = Number(url.searchParams.get("range"));
  const rangeDays = (RANGE_OPTIONS as readonly number[]).includes(rangeParam)
    ? rangeParam
    : 30;

  const shop = await getPrimaryShop();
  if (!shop) {
    return json({ ready: false as const, rangeDays });
  }

  const [funnel, ltgp, survival, forecast, cancelGroups] = await Promise.all([
    getFunnelMetrics(shop.id, rangeDays),
    getLtgpSummary(shop.id),
    getSurvivalByCycle(shop.id),
    getForecast(shop.id),
    prisma.subscriptionContract.groupBy({
      by: ["cancelSource"],
      where: { shopId: shop.id, status: "CANCELLED" },
      _count: { _all: true },
    }),
  ]);

  let voluntaryChurn = 0;
  let involuntaryChurn = 0;
  for (const group of cancelGroups) {
    if (group.cancelSource === "DUNNING") involuntaryChurn += group._count._all;
    else voluntaryChurn += group._count._all;
  }

  return json({
    ready: true as const,
    rangeDays,
    currencyCode: shop.currencyCode,
    funnel,
    ltgp,
    survival,
    forecast: {
      historyWeeks: forecast.historyWeeks,
      historyMrrCents: forecast.historyMrrCents,
      historyActiveSubscribers: forecast.historyActiveSubscribers,
      projectedWeeks: forecast.projectedWeeks,
      projectedMrrCents: forecast.projectedMrrCents,
      projectedActiveSubscribers: forecast.projectedActiveSubscribers,
      model: forecast.model,
    },
    churnSplit: { voluntaryChurn, involuntaryChurn },
  });
};

type LoaderData = SerializeFrom<typeof loader>;
type ReadyData = Extract<LoaderData, { ready: true }>;

// ── Formatting helpers ────────────────────────────────────────────────────────

function humanizeCode(code: string): string {
  const lower = code.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function pctLabel(fraction: number | null, digits = 1): string {
  return fraction == null ? "—" : `${(fraction * 100).toFixed(digits)}%`;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const data = useLoaderData<typeof loader>();
  const [selected, setSelected] = useState(0);

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
    { id: "survival", content: "Survival" },
    { id: "forecast", content: "Forecast" },
  ];

  return (
    <Page
      title="Analytics"
      subtitle="Funnel, cohort profitability, retention and forecasts"
    >
      <BlockStack gap="400">
        <Tabs tabs={tabs} selected={selected} onSelect={setSelected}>
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

// ── Overview ──────────────────────────────────────────────────────────────────

function OverviewTab({ data }: { data: ReadyData }) {
  const [, setSearchParams] = useSearchParams();
  const { funnel, rangeDays } = data;

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

  const saveRateRows = funnel.saveRateByReason.map((row) => [
    humanizeCode(row.reason),
    row.sessions,
    row.saved,
    pctLabel(row.saveRate),
  ]);

  return (
    <BlockStack gap="400">
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
          title="Subscription take rate"
          value={funnel.takeRatePct != null ? `${funnel.takeRatePct}%` : "—"}
          helpText={
            funnel.takeRatePct != null
              ? "Of checkouts containing a subscribable product, the share that chose the subscription option."
              : "Shows a value once the storefront checkout counter starts reporting subscribable checkouts."
          }
        />
        <StatCard
          title="Dunning recovery rate"
          value={pctLabel(funnel.dunningRecoveryRate)}
          helpText="Of failed-payment cases closed in this window, the share where the money was recovered."
        />
        <StatCard
          title="Skip : cancel ratio"
          value={
            funnel.skipToCancelRatio != null
              ? `${funnel.skipToCancelRatio.toFixed(1)} : 1`
              : "—"
          }
          helpText="Skips per cancellation. Higher is healthier — skipping is a pressure valve that avoids churn."
        />
        <StatCard
          title="Add-on attach rate"
          value={pctLabel(funnel.addonAttachRate)}
          helpText="One-time add-ons attached per successful renewal charge in this window."
        />
        <StatCard
          title="Prepaid mix"
          value={`${funnel.prepaidMixPct}%`}
          helpText="Share of active subscribers on prepaid (bill once, ship several times) plans."
        />
        <StatCard
          title="Cancel-flow sessions"
          value={funnel.saveRateByReason
            .reduce((sum, r) => sum + r.sessions, 0)
            .toLocaleString("en")}
          helpText="Subscribers who entered the cancel flow and gave a reason in this window."
        />
      </InlineGrid>

      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">
            Save rate by cancel reason
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            For each reason subscribers give when cancelling: how many sessions
            were started, and how many ended with the subscriber staying
            (accepting a skip, pause, discount or swap instead).
          </Text>
          {saveRateRows.length === 0 ? (
            <Text as="p" variant="bodySm" tone="subdued">
              No cancel-flow sessions with a recorded reason in this window yet.
            </Text>
          ) : (
            <DataTable
              columnContentTypes={["text", "numeric", "numeric", "numeric"]}
              headings={["Reason", "Sessions", "Saved", "Save rate"]}
              rows={saveRateRows}
            />
          )}
        </BlockStack>
      </Card>
    </BlockStack>
  );
}

// ── Cohorts & LTGP ────────────────────────────────────────────────────────────

function CohortsTab({ data }: { data: ReadyData }) {
  const { ltgp, currencyCode } = data;

  const money = (cents: number | null): string =>
    cents == null ? "—" : formatMoney(cents, currencyCode);
  const total = (perSubCents: number | null, size: number): string =>
    perSubCents == null ? "—" : formatMoney(perSubCents * size, currencyCode);

  const rows: ReactNode[][] = ltgp.cohorts.map((c) => [
    c.cohortMonth,
    c.cohortSize,
    money(c.ltgpM3Cents),
    total(c.ltgpM3Cents, c.cohortSize),
    money(c.ltgpM6Cents),
    total(c.ltgpM6Cents, c.cohortSize),
    money(c.ltgpM12Cents),
    total(c.ltgpM12Cents, c.cohortSize),
  ]);

  if (ltgp.cohorts.length > 0) {
    rows.push([
      <Text as="span" fontWeight="semibold" key="wavg">
        Weighted average
      </Text>,
      "",
      <Text as="span" fontWeight="semibold" key="m3">
        {money(ltgp.weightedAvg.m3Cents)}
      </Text>,
      "",
      <Text as="span" fontWeight="semibold" key="m6">
        {money(ltgp.weightedAvg.m6Cents)}
      </Text>,
      "",
      <Text as="span" fontWeight="semibold" key="m12">
        {money(ltgp.weightedAvg.m12Cents)}
      </Text>,
      "",
    ]);
  }

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">
            Cohort lifetime gross profit
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            LTGP = payments actually collected (already net of subscription
            discounts) − product COGS − shipping − payment processing fees
            (2.9% + 30¢ per charge), accumulated by signup-month cohort.
            &ldquo;/ sub&rdquo; divides by cohort size; a horizon shows — until
            the cohort has fully aged past it, so young cohorts never drag the
            averages down.
          </Text>
          {rows.length === 0 ? (
            <Text as="p" variant="bodySm" tone="subdued">
              No cohorts yet — cohort cells are computed by the daily analytics
              job once contracts exist.
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
    </BlockStack>
  );
}

// ── Survival ──────────────────────────────────────────────────────────────────

function SurvivalTab({ data }: { data: ReadyData }) {
  const { survival, churnSplit } = data;

  const toPoints = (fractions: number[]) =>
    survival.cycles.map((cycle, i) => ({ cycle, pct: fractions[i] ?? 0 }));

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">
            Survival by billing cycle
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Share of all {survival.totalContracts.toLocaleString("en")}{" "}
            subscribers still active at each billing cycle. The voluntary and
            involuntary curves each count only that churn cause as a loss — the
            gap below 100% is that cause&rsquo;s cumulative damage, so the two
            gaps together explain total churn.
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
            xAxisLabel="Billing cycle"
            accessibilityLabel="Subscriber survival by billing cycle, split by churn cause"
          />
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">
            Churn split
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            All cancelled contracts by cause. Involuntary churn is cancelled by
            the dunning engine after payment retries were exhausted — fix it
            with better dunning, not with save offers.
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
            ]}
            accessibilityLabel="Voluntary versus involuntary churn split"
          />
        </BlockStack>
      </Card>
    </BlockStack>
  );
}

// ── Forecast ──────────────────────────────────────────────────────────────────

function ForecastTab({ data }: { data: ReadyData }) {
  const { forecast, currencyCode } = data;

  const mrrSeries = [
    ...forecast.historyWeeks.map((week, i) => ({
      label: dateKeyLabel(week),
      value: forecast.historyMrrCents[i] ?? 0,
    })),
    ...forecast.projectedWeeks.map((week, i) => ({
      label: dateKeyLabel(week),
      value: forecast.projectedMrrCents[i] ?? 0,
    })),
  ];
  const subscriberSeries = [
    ...forecast.historyWeeks.map((week, i) => ({
      label: dateKeyLabel(week),
      value: forecast.historyActiveSubscribers[i] ?? 0,
    })),
    ...forecast.projectedWeeks.map((week, i) => ({
      label: dateKeyLabel(week),
      value: forecast.projectedActiveSubscribers[i] ?? 0,
    })),
  ];
  const splitIndex = forecast.historyWeeks.length;
  const { model } = forecast;

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">
            MRR — observed and projected
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Weekly MRR snapshots (solid) with a 12-week projection (dashed)
            from trend-following exponential smoothing.
          </Text>
          <LineChart
            data={mrrSeries}
            height={260}
            projectedFromIndex={splitIndex}
            formatValue={(v) => compactMoney(v, currencyCode)}
            accessibilityLabel="Observed weekly MRR with a 12-week projection"
          />
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">
            Active subscribers — observed and projected
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Weekly active-subscriber snapshots (solid) with a 12-week decay
            projection (dashed) from the observed survival curve. New-subscriber
            inflow is deliberately excluded — treat the dashed line as the floor
            if acquisition stopped today.
          </Text>
          <LineChart
            data={subscriberSeries}
            height={260}
            color={CHART_COLORS.success}
            projectedFromIndex={splitIndex}
            formatValue={compactNumber}
            accessibilityLabel="Observed weekly active subscribers with a 12-week projection"
          />
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="200">
          <Text as="h3" variant="headingMd">
            Model
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            MRR: Holt linear exponential smoothing (α {model.alpha}, β{" "}
            {model.beta}) over up to 26 weeks of rollups. Subscribers: the
            current active base decays at the observed per-cycle survival of{" "}
            {(model.avgCycleSurvival * 100).toFixed(1)}% (≈
            {(model.weeklyRetention * 100).toFixed(2)}% weekly at the average{" "}
            {model.avgIntervalWeeks}-week billing interval).
          </Text>
        </BlockStack>
      </Card>
    </BlockStack>
  );
}
