import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  DataTable,
  EmptyState,
  InlineGrid,
  InlineStack,
  Link as PolarisLink,
  Page,
  Text,
} from "@shopify/polaris";
import { subDays } from "date-fns";

import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { getLaunchState } from "~/lib/launch/launch.server";
import {
  getDashboardStats,
  getFailedPaymentsQueue,
  getForecast,
} from "~/lib/analytics/index.server";
import { formatMoney } from "~/lib/money";
import {
  BarPairChart,
  LineChart,
  Sparkline,
  StatCard,
  CHART_COLORS,
  compactMoney,
  dateKeyLabel,
} from "~/components/charts";

const DAY_MS = 86_400_000;
const MRR_TREND_DAYS = 90;
const TOP_N = 5;

const SEVERITY_RANK: Record<string, number> = {
  CRITICAL: 0,
  WARNING: 1,
  INFO: 2,
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const shop = await getPrimaryShop();
  if (!shop) {
    // Fresh install before the afterAuth hook has created the Shop row.
    return json({ ready: false as const });
  }

  const now = new Date();
  const [launch, stats, failedQueue, alertRows, forecast, rollups] = await Promise.all([
    getLaunchState(shop.id),
    getDashboardStats(shop.id),
    getFailedPaymentsQueue(shop.id),
    prisma.alert.findMany({
      where: { shopId: shop.id, resolvedAt: null },
      orderBy: { createdAt: "desc" },
      take: 25,
    }),
    getForecast(shop.id, now),
    prisma.dailyRollup.findMany({
      where: { shopId: shop.id, date: { gte: subDays(now, MRR_TREND_DAYS) } },
      orderBy: { date: "asc" },
      select: { date: true, mrrCents: true },
    }),
  ]);

  const mrrTrend = rollups.map((r) => ({
    label: dateKeyLabel(r.date.toISOString().slice(0, 10)),
    value: r.mrrCents,
  }));

  const failedTop = failedQueue.slice(0, TOP_N).map((row) => ({
    caseId: row.caseId,
    contractId: row.contractId,
    email: row.email,
    name: [row.firstName, row.lastName].filter(Boolean).join(" ") || null,
    amountCents: row.amountCents,
    currencyCode: row.currencyCode ?? shop.currencyCode,
    declineCode: row.declineCode,
    declineCategory: row.declineCategory,
    state: row.state,
    daysOpen: Math.max(0, Math.floor((now.getTime() - row.openedAt.getTime()) / DAY_MS)),
    nextRetryAt: row.nextRetryAt
      ? dateKeyLabel(row.nextRetryAt.toISOString().slice(0, 10))
      : null,
  }));

  const alerts = [...alertRows]
    .sort(
      (a, b) =>
        (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) ||
        b.createdAt.getTime() - a.createdAt.getTime(),
    )
    .slice(0, TOP_N)
    .map((a) => ({
      id: a.id,
      type: a.type,
      severity: a.severity,
      message: a.message,
    }));

  const weekCount = stats.newVsChurnedByWeek.weeks.length;
  const thisWeekNew =
    weekCount > 0 ? stats.newVsChurnedByWeek.newSubscribers[weekCount - 1] : 0;
  const thisWeekChurned =
    weekCount > 0 ? stats.newVsChurnedByWeek.churned[weekCount - 1] : 0;

  const projectedMrrCents =
    forecast.projectedMrrCents.length > 0
      ? forecast.projectedMrrCents[forecast.projectedMrrCents.length - 1]
      : null;
  const projectedSubscribers =
    forecast.projectedActiveSubscribers.length > 0
      ? forecast.projectedActiveSubscribers[
          forecast.projectedActiveSubscribers.length - 1
        ]
      : null;
  const mrrDeltaPct =
    projectedMrrCents != null && stats.mrrCents > 0
      ? Math.round(((projectedMrrCents - stats.mrrCents) / stats.mrrCents) * 1000) / 10
      : null;

  return json({
    ready: true as const,
    setupMode: launch.mode === "SETUP",
    currencyCode: shop.currencyCode,
    activeSubscribers: stats.activeSubscribers,
    pausedCount: stats.pausedCount,
    mrrCents: stats.mrrCents,
    failedTotal: stats.failedQueueCount,
    openAlertCount: stats.openAlerts,
    recoveredThisMonthCents: stats.recoveredThisMonthCents,
    thisWeekNew,
    thisWeekChurned,
    newVsChurned: {
      labels: stats.newVsChurnedByWeek.weeks.map(dateKeyLabel),
      newSubscribers: stats.newVsChurnedByWeek.newSubscribers,
      churned: stats.newVsChurnedByWeek.churned,
    },
    mrrTrend,
    failedTop,
    alerts,
    forecastSummary: {
      projectedMrrCents,
      projectedSubscribers,
      mrrDeltaPct,
      sparkMrr: forecast.projectedMrrCents,
      sparkSubscribers: forecast.projectedActiveSubscribers,
    },
  });
};

function alertTone(severity: string): "critical" | "warning" | "info" {
  if (severity === "CRITICAL") return "critical";
  if (severity === "WARNING") return "warning";
  return "info";
}

function humanizeCode(code: string): string {
  const lower = code.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();

  if (!data.ready) {
    return (
      <Page title="Dashboard">
        <Card>
          <EmptyState
            heading="Welcome to Cellexia Subscriptions"
            action={{ content: "Set up subscription plans", url: "/app/plans" }}
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <p>
              The app is finishing its first sync with your store. Start by
              creating a subscription plan — the dashboard fills in as
              subscribers arrive.
            </p>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  const {
    setupMode,
    currencyCode,
    activeSubscribers,
    pausedCount,
    mrrCents,
    failedTotal,
    recoveredThisMonthCents,
    thisWeekNew,
    thisWeekChurned,
    newVsChurned,
    mrrTrend,
    failedTop,
    alerts,
    forecastSummary,
  } = data;

  const isFreshInstall =
    activeSubscribers === 0 &&
    pausedCount === 0 &&
    mrrTrend.length === 0 &&
    failedTotal === 0;

  const setupBanner = setupMode ? (
    <Banner
      tone="info"
      title="Setup mode — your live store is untouched"
      action={{ content: "Preview & go live", url: "/app/preview" }}
    >
      <p>
        Nothing is visible to store visitors, no renewals are charged and no
        customer emails are sent. Preview the storefront widget and the
        customer portal, then go live when everything looks right.
      </p>
    </Banner>
  ) : null;

  if (isFreshInstall) {
    return (
      <Page title="Dashboard" subtitle="Subscription health at a glance">
        <BlockStack gap="400">
          {setupBanner}
          {alerts.map((alert) => (
            <Banner
              key={alert.id}
              tone={alertTone(alert.severity)}
              title={humanizeCode(alert.type)}
              action={{ content: "View alerts", url: "/app/alerts" }}
            >
              <p>{alert.message}</p>
            </Banner>
          ))}
          <Card>
            <EmptyState
              heading="Set up your first subscription plan"
              action={{ content: "Create a plan", url: "/app/plans" }}
              secondaryAction={{
                content: "Import existing subscribers",
                url: "/app/import",
              }}
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>
                Create a Subscribe &amp; Save selling plan to start offering
                subscriptions on your product pages. Once subscribers start
                rolling in, this dashboard tracks MRR, new vs churned
                subscribers, failed payments and a 12-week forecast.
              </p>
            </EmptyState>
          </Card>
        </BlockStack>
      </Page>
    );
  }

  const failedRows = failedTop.map((row) => [
    <PolarisLink key={row.caseId} url="/app/dunning" removeUnderline>
      {row.email}
    </PolarisLink>,
    row.amountCents != null
      ? formatMoney(row.amountCents, row.currencyCode)
      : "—",
    `${row.declineCode ?? humanizeCode(row.state)}${
      row.declineCategory ? ` (${row.declineCategory})` : ""
    }`,
    row.daysOpen,
    row.nextRetryAt ?? "—",
  ]);

  return (
    <Page title="Dashboard" subtitle="Subscription health at a glance">
      <BlockStack gap="500">
        {setupBanner}
        {alerts.length > 0 && (
          <BlockStack gap="200">
            {alerts.map((alert) => (
              <Banner
                key={alert.id}
                tone={alertTone(alert.severity)}
                title={humanizeCode(alert.type)}
                action={{ content: "View alerts", url: "/app/alerts" }}
              >
                <p>{alert.message}</p>
              </Banner>
            ))}
          </BlockStack>
        )}

        <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
          <StatCard
            title="Active subscribers"
            value={activeSubscribers.toLocaleString("en")}
            helpText={`${pausedCount.toLocaleString("en")} paused`}
          />
          <StatCard
            title="MRR"
            value={formatMoney(mrrCents, currencyCode)}
            helpText="Monthly recurring revenue, normalized across billing frequencies"
          />
          <StatCard
            title="New vs churned this week"
            value={`+${thisWeekNew} / −${thisWeekChurned}`}
            tone={thisWeekNew >= thisWeekChurned ? "success" : "critical"}
            delta={thisWeekNew >= thisWeekChurned ? "net growth" : "net loss"}
            helpText="New subscribers vs cancellations, current week"
          />
          <StatCard
            title="Failed payments queue"
            value={failedTotal.toLocaleString("en")}
            tone={failedTotal > 0 ? "attention" : "success"}
            delta={failedTotal > 0 ? "needs attention" : "all clear"}
            helpText={`${formatMoney(recoveredThisMonthCents, currencyCode)} recovered this month`}
          />
        </InlineGrid>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              MRR trend
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Daily monthly-recurring-revenue snapshots over the last 90 days.
            </Text>
            <LineChart
              data={mrrTrend}
              height={240}
              formatValue={(v) => compactMoney(v, currencyCode)}
              accessibilityLabel="MRR trend over the last 90 days"
            />
          </BlockStack>
        </Card>

        <InlineGrid columns={{ xs: 1, lg: 2 }} gap="400">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                New vs churned subscribers
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Weekly totals for the last 12 weeks.
              </Text>
              <BarPairChart
                labels={newVsChurned.labels}
                seriesA={{ name: "New", values: newVsChurned.newSubscribers }}
                seriesB={{ name: "Churned", values: newVsChurned.churned }}
                height={220}
                accessibilityLabel="New versus churned subscribers by week, last 12 weeks"
              />
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  12-week outlook
                </Text>
                <Button url="/app/analytics" variant="plain">
                  Open analytics
                </Button>
              </InlineStack>
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
                <BlockStack gap="150">
                  <Text as="h3" variant="headingSm" tone="subdued">
                    Projected MRR
                  </Text>
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <Text as="p" variant="headingLg">
                      {forecastSummary.projectedMrrCents != null
                        ? formatMoney(forecastSummary.projectedMrrCents, currencyCode)
                        : "—"}
                    </Text>
                  </InlineStack>
                  {forecastSummary.mrrDeltaPct != null && (
                    <Text
                      as="p"
                      variant="bodySm"
                      tone={forecastSummary.mrrDeltaPct >= 0 ? "success" : "critical"}
                    >
                      {forecastSummary.mrrDeltaPct >= 0 ? "+" : ""}
                      {forecastSummary.mrrDeltaPct}% vs today
                    </Text>
                  )}
                  <Sparkline
                    values={forecastSummary.sparkMrr}
                    accessibilityLabel="Projected MRR over the next 12 weeks"
                  />
                </BlockStack>
                <BlockStack gap="150">
                  <Text as="h3" variant="headingSm" tone="subdued">
                    Projected subscribers
                  </Text>
                  <Text as="p" variant="headingLg">
                    {forecastSummary.projectedSubscribers != null
                      ? forecastSummary.projectedSubscribers.toLocaleString("en")
                      : "—"}
                  </Text>
                  <Box paddingBlockStart="400">
                    <Sparkline
                      values={forecastSummary.sparkSubscribers}
                      color={CHART_COLORS.success}
                      accessibilityLabel="Projected active subscribers over the next 12 weeks"
                    />
                  </Box>
                </BlockStack>
              </InlineGrid>
              <Text as="p" variant="bodySm" tone="subdued">
                Projection from smoothed weekly MRR and observed cohort
                survival. New-subscriber inflow is not included, so this is a
                conservative floor.
              </Text>
            </BlockStack>
          </Card>
        </InlineGrid>

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Failed payments
              </Text>
              <Button url="/app/dunning" variant="plain">
                {`View all (${failedTotal})`}
              </Button>
            </InlineStack>
            {failedTop.length === 0 ? (
              <Text as="p" variant="bodySm" tone="subdued">
                No open dunning cases — every renewal charge is going through.
              </Text>
            ) : (
              <DataTable
                columnContentTypes={["text", "numeric", "text", "numeric", "text"]}
                headings={["Subscriber", "Amount", "Decline", "Days open", "Next retry"]}
                rows={failedRows}
              />
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
