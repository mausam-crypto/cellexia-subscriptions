import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Banner,
  BlockStack,
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
import { toZonedTime, format as formatTz } from "date-fns-tz";

import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { getLaunchState } from "~/lib/launch/launch.server";
import {
  getDashboardStats,
  getFailedPaymentsQueue,
  getForecast,
} from "~/lib/analytics/index.server";
import { getInsights } from "~/lib/analytics/insights.server";
import { formatMoney } from "~/lib/money";
import {
  AccuracyGradeChip,
  BarPairChart,
  DeltaStat,
  InsightCards,
  LineChart,
  Sparkline,
  compactMoney,
  dateKeyLabel,
  finite,
} from "~/components/charts";
import type { AccuracyGrade, DeltaStatDelta } from "~/components/charts";

const DAY_MS = 86_400_000;
const MRR_TREND_DAYS = 90;
const TOP_N = 5;
/** Forecast teaser horizon: the next 4 projected weeks. */
const TEASER_WEEKS = 4;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const shop = await getPrimaryShop();
  if (!shop) {
    // Fresh install before the afterAuth hook has created the Shop row.
    return json({ ready: false as const });
  }

  const now = new Date();
  const tz = shop.ianaTimezone;

  // DailyRollup.date keys are shop-timezone day LABELS (synthetic UTC
  // midnights), so the trend cutoff is derived in label space from the shop-tz
  // "today" — comparing labels against a raw UTC instant is off by up to a day
  // for Europe/Zurich.
  const todayKey = formatTz(toZonedTime(now, tz), "yyyy-MM-dd", { timeZone: tz });
  const todayLabel = new Date(`${todayKey}T00:00:00.000Z`);
  const trendCutoff = new Date(todayLabel.getTime() - (MRR_TREND_DAYS - 1) * DAY_MS);

  const alertsFor = (severity: string) =>
    prisma.alert.findMany({
      where: { shopId: shop.id, resolvedAt: null, severity },
      orderBy: { createdAt: "desc" },
      take: TOP_N,
    });

  // ONE forecast run per dashboard load: insights reuse this promise's
  // accuracy grade for rule 7 instead of getInsights self-computing a
  // duplicate forecast (~5 queries + the full rollup history fetch). A failed
  // forecast degrades insights to "no grade" (the known-unknown contract) —
  // the Promise.all still rejects on the forecast element itself, unchanged.
  const forecastPromise = getForecast(shop.id);
  const [
    launch,
    stats,
    failedQueue,
    criticalAlerts,
    warningAlerts,
    infoAlerts,
    forecast,
    rollups,
    insights,
  ] = await Promise.all([
    getLaunchState(shop.id),
    getDashboardStats(shop.id),
    getFailedPaymentsQueue(shop.id),
    // Severity-first triage: a days-old CRITICAL alert must never be buried
    // under a pile of newer INFO notices.
    alertsFor("CRITICAL"),
    alertsFor("WARNING"),
    alertsFor("INFO"),
    forecastPromise,
    prisma.dailyRollup.findMany({
      where: { shopId: shop.id, date: { gte: trendCutoff } },
      orderBy: { date: "asc" },
      select: {
        date: true,
        mrrCents: true,
        activeSubscribers: true,
        openDunningCases: true,
      },
    }),
    forecastPromise.then(
      (f) => getInsights(shop.id, now, { forecastGrade: f.accuracy.grade }),
      () => getInsights(shop.id, now, { forecastGrade: null }),
    ),
  ]);

  const mrrTrend = rollups.map((r) => ({
    label: dateKeyLabel(r.date.toISOString().slice(0, 10)),
    value: r.mrrCents,
  }));

  // Reference rollup rows for week-over-week / 4-week deltas (nearest row at
  // or before the target label day; null when history is too short).
  const rowDaysAgo = (days: number) => {
    const target = todayLabel.getTime() - days * DAY_MS;
    for (let i = rollups.length - 1; i >= 0; i--) {
      if (rollups[i].date.getTime() <= target) return rollups[i];
    }
    return null;
  };
  const ref7 = rowDaysAgo(7);
  const ref28 = rowDaysAgo(28);

  // nextRetryAt is a real instant — format its calendar day in the SHOP
  // timezone, not the UTC day (a 00:30 Zurich retry is still "yesterday" UTC).
  const shopDayLabel = new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    timeZone: tz,
  });

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
    nextRetryAt: row.nextRetryAt ? shopDayLabel.format(row.nextRetryAt) : null,
  }));

  const alerts = [...criticalAlerts, ...warningAlerts, ...infoAlerts]
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

  // Forecast teaser: the projection TEASER_WEEKS out, plus the engine's
  // accuracy grade so nobody trusts a week-1 forecast like a week-20 one.
  const teaserIdx = Math.min(TEASER_WEEKS, forecast.projectedMrrCents.length) - 1;
  const teaserMrrCents = teaserIdx >= 0 ? forecast.projectedMrrCents[teaserIdx] : null;
  const forecastGrade: AccuracyGrade = forecast.accuracy.grade;

  const teaserDeltaPct =
    teaserMrrCents != null && stats.mrrCents > 0
      ? Math.round(((teaserMrrCents - stats.mrrCents) / stats.mrrCents) * 1000) / 10
      : null;

  const lastRollupMrr = rollups.length > 0 ? rollups[rollups.length - 1].mrrCents : null;
  const mrr4wDeltaCents =
    lastRollupMrr != null && ref28 != null ? lastRollupMrr - ref28.mrrCents : null;
  const mrr4wDeltaPct =
    mrr4wDeltaCents != null && ref28 != null && ref28.mrrCents > 0
      ? Math.round((mrr4wDeltaCents / ref28.mrrCents) * 1000) / 10
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
    weekAgo: ref7
      ? {
          mrrCents: ref7.mrrCents,
          activeSubscribers: ref7.activeSubscribers,
          openDunningCases: ref7.openDunningCases,
        }
      : null,
    mrr4wDeltaCents,
    mrr4wDeltaPct,
    mrrTrend,
    failedTop,
    alerts,
    insights,
    forecastTeaser: {
      teaserWeeks: TEASER_WEEKS,
      projectedMrrCents: teaserMrrCents,
      deltaPct: teaserDeltaPct,
      grade: forecastGrade,
      sparkMrr: forecast.projectedMrrCents,
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

/** WoW delta for a count metric where UP is good (subscribers). */
function countDelta(current: number, previous: number | null): DeltaStatDelta | null {
  if (previous == null) return null;
  const diff = current - previous;
  if (diff === 0) return { label: "no change WoW", direction: "flat", tone: "neutral" };
  return {
    label: `${diff > 0 ? "+" : ""}${diff.toLocaleString("en")} WoW`,
    direction: diff > 0 ? "up" : "down",
    tone: diff > 0 ? "positive" : "negative",
  };
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
    openAlertCount,
    recoveredThisMonthCents,
    thisWeekNew,
    thisWeekChurned,
    newVsChurned,
    weekAgo,
    mrr4wDeltaCents,
    mrr4wDeltaPct,
    mrrTrend,
    failedTop,
    alerts,
    insights,
    forecastTeaser,
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

  const alertBanners =
    alerts.length > 0 ? (
      <BlockStack gap="200">
        {alerts.map((alert) => (
          <Banner
            key={alert.id}
            tone={alertTone(alert.severity)}
            title={humanizeCode(alert.type)}
            action={{
              content:
                openAlertCount > alerts.length
                  ? `View all alerts (${openAlertCount})`
                  : "View alerts",
              url: "/app/alerts",
            }}
          >
            <p>{alert.message}</p>
          </Banner>
        ))}
      </BlockStack>
    ) : null;

  if (isFreshInstall) {
    return (
      <Page title="Dashboard" subtitle="Subscription health at a glance">
        <BlockStack gap="400">
          {setupBanner}
          {alertBanners}
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

  // ── Stat deltas ──
  const mrrWowPct =
    weekAgo && weekAgo.mrrCents > 0
      ? Math.round(((mrrCents - weekAgo.mrrCents) / weekAgo.mrrCents) * 1000) / 10
      : null;
  const mrrDelta: DeltaStatDelta | null =
    mrrWowPct == null
      ? null
      : mrrWowPct === 0
        ? { label: "no change WoW", direction: "flat", tone: "neutral" }
        : {
            label: `${mrrWowPct > 0 ? "+" : ""}${mrrWowPct}% WoW`,
            direction: mrrWowPct > 0 ? "up" : "down",
            tone: mrrWowPct > 0 ? "positive" : "negative",
          };

  const net = thisWeekNew - thisWeekChurned;
  // No badge when nothing happened — "+0 / −0 net growth" is noise.
  const netDelta: DeltaStatDelta | null =
    thisWeekNew === 0 && thisWeekChurned === 0
      ? null
      : {
          label: net === 0 ? "flat" : `net ${net > 0 ? "+" : ""}${net}`,
          direction: net > 0 ? "up" : net < 0 ? "down" : "flat",
          tone: net > 0 ? "positive" : net < 0 ? "negative" : "neutral",
        };

  const failedDiff = weekAgo != null ? failedTotal - weekAgo.openDunningCases : null;
  // Failed queue: DOWN is good.
  const failedDelta: DeltaStatDelta | null =
    failedDiff == null || failedDiff === 0
      ? failedTotal === 0
        ? { label: "all clear", direction: "flat", tone: "positive" }
        : null
      : {
          label: `${failedDiff > 0 ? "+" : ""}${failedDiff} WoW`,
          direction: failedDiff > 0 ? "up" : "down",
          tone: failedDiff > 0 ? "negative" : "positive",
        };

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

  const mrr4wText =
    mrr4wDeltaCents != null
      ? `${mrr4wDeltaCents >= 0 ? "+" : "−"}${formatMoney(Math.abs(mrr4wDeltaCents), currencyCode)}${
          mrr4wDeltaPct != null ? ` (${mrr4wDeltaPct >= 0 ? "+" : ""}${mrr4wDeltaPct}%)` : ""
        } vs 4 weeks ago`
      : null;

  return (
    <Page title="Dashboard" subtitle="Subscription health at a glance">
      <BlockStack gap="500">
        {setupBanner}
        {alertBanners}

        {insights.length > 0 && (
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              This week
            </Text>
            <InsightCards insights={insights} />
          </BlockStack>
        )}

        <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
          <DeltaStat
            title="Active subscribers"
            value={activeSubscribers.toLocaleString("en")}
            delta={countDelta(activeSubscribers, weekAgo?.activeSubscribers ?? null)}
            helpText={`${pausedCount.toLocaleString("en")} paused`}
          />
          <DeltaStat
            title="MRR"
            value={formatMoney(mrrCents, currencyCode)}
            delta={mrrDelta}
            helpText="Monthly recurring revenue, normalized across billing frequencies"
          />
          <DeltaStat
            title="New vs churned"
            value={`+${thisWeekNew} / −${thisWeekChurned}`}
            delta={netDelta}
            helpText="New subscribers vs cancellations, current week"
          />
          <DeltaStat
            title="Failed payments queue"
            value={failedTotal.toLocaleString("en")}
            delta={failedDelta}
            helpText={`${formatMoney(recoveredThisMonthCents, currencyCode)} recovered this month`}
          />
        </InlineGrid>

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                MRR trend
              </Text>
              {mrr4wText && (
                <Text
                  as="span"
                  variant="bodySm"
                  tone={finite(mrr4wDeltaCents) >= 0 ? "success" : "critical"}
                >
                  {mrr4wText}
                </Text>
              )}
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              Daily monthly-recurring-revenue snapshots, last 90 days.
            </Text>
            <LineChart
              data={mrrTrend}
              height={240}
              area
              showLastValue
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
                Weekly totals, last 12 weeks. Internal consolidation merges are
                not counted as churn.
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
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Next {forecastTeaser.teaserWeeks} weeks
                  </Text>
                  {forecastTeaser.grade && (
                    <AccuracyGradeChip grade={forecastTeaser.grade} />
                  )}
                </InlineStack>
                <Button url="/app/analytics?tab=forecast" variant="plain">
                  Open forecast
                </Button>
              </InlineStack>
              <BlockStack gap="150">
                <Text as="h3" variant="headingSm" tone="subdued">
                  Projected MRR in {forecastTeaser.teaserWeeks} weeks
                </Text>
                <InlineStack gap="200" blockAlign="center" wrap={false}>
                  <Text as="p" variant="headingLg">
                    {forecastTeaser.projectedMrrCents != null
                      ? formatMoney(forecastTeaser.projectedMrrCents, currencyCode)
                      : "—"}
                  </Text>
                  {forecastTeaser.deltaPct != null && (
                    <Text
                      as="span"
                      variant="bodySm"
                      tone={forecastTeaser.deltaPct >= 0 ? "success" : "critical"}
                    >
                      {forecastTeaser.deltaPct >= 0 ? "+" : ""}
                      {forecastTeaser.deltaPct}% vs today
                    </Text>
                  )}
                </InlineStack>
                <Sparkline
                  values={forecastTeaser.sparkMrr}
                  accessibilityLabel="Projected MRR over the coming weeks"
                />
              </BlockStack>
              <Text as="p" variant="bodySm" tone="subdued">
                Projection from smoothed weekly MRR history. New-subscriber
                inflow is not included, so treat this as a conservative floor.
                The grade chip shows how much history backs it.
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
