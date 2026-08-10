import { useMemo } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Link as PolarisLink,
  Page,
  Text,
} from "@shopify/polaris";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import {
  getLastSelfCheckReport,
  runSelfCheck,
  type SelfCheckReport,
  type SelfCheckResult,
} from "~/lib/debug/selfcheck.server";

/**
 * Admin — Debug.
 *
 * The live self-check console: every key feature of the app (billing
 * pipeline, dunning/retries, customer portal through the real app proxy,
 * webhooks, jobs, notifications, Klaviyo, configuration, data integrity)
 * probed against the DEPLOYED store, not a local assumption. The same suite
 * runs automatically every 30 minutes (`selfcheck_run`); a broken run raises
 * one CRITICAL SELF_CHECK_FAILED alert (which emails Settings → alerts →
 * emailTo) and the alert auto-resolves when a later run comes back clean.
 * This page shows the stored report instantly and can re-run on demand.
 */

const CATEGORY_ORDER = [
  "Platform",
  "Shopify connection",
  "Launch & storefront",
  "Customer portal",
  "Billing",
  "Dunning & retries",
  "Jobs",
  "Notifications",
  "Data integrity",
] as const;

interface LoaderData {
  report: SelfCheckReport | null;
  lastJobRunAt: string | null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }

  const [report, lastJobRun] = await Promise.all([
    getLastSelfCheckReport(shop.id),
    prisma.jobRun.findFirst({
      where: { jobName: "selfcheck_run" },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    }),
  ]);

  return json<LoaderData>({
    report,
    lastJobRunAt: lastJobRun?.startedAt.toISOString() ?? null,
  });
};

interface ActionResponse {
  ok: boolean;
  report?: SelfCheckReport;
  error?: string;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }
  const actor =
    session.onlineAccessInfo?.associated_user?.email ?? `admin@${session.shop}`;

  try {
    const report = await runSelfCheck(shop.domain, {
      trigger: "admin",
      actor,
    });
    return json<ActionResponse>({ ok: true, report });
  } catch (err) {
    console.error("[admin] debug self-check run failed", err);
    return json<ActionResponse>({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

// ── View ─────────────────────────────────────────────────────────────────────

const CHECK_BADGES: Record<
  SelfCheckResult["status"],
  { tone?: "success" | "critical" | "warning"; label: string }
> = {
  PASS: { tone: "success", label: "Pass" },
  FAIL: { tone: "critical", label: "Fail" },
  WARN: { tone: "warning", label: "Check" },
  SKIP: { label: "Skipped" },
};

const VERDICT_BADGES: Record<
  SelfCheckReport["verdict"],
  { tone: "success" | "critical" | "warning"; label: string }
> = {
  HEALTHY: { tone: "success", label: "Healthy" },
  DEGRADED: { tone: "warning", label: "Needs attention" },
  BROKEN: { tone: "critical", label: "Broken" },
};

function agoLabel(iso: string): string {
  const minutes = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 60_000),
  );
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 6) / 10;
  return `${hours}h ago`;
}

function CheckRow({ check }: { check: SelfCheckResult }) {
  const badge = CHECK_BADGES[check.status];
  return (
    <InlineStack gap="300" blockAlign="start" wrap={false}>
      <Box minWidth="72px">
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </Box>
      <BlockStack gap="050">
        <Text as="p" variant="bodyMd" fontWeight="medium">
          {check.label}
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          {check.detail}
        </Text>
        {check.remediation && check.status !== "PASS" ? (
          <Text as="p" variant="bodySm" fontWeight="medium">
            {`Fix: ${check.remediation}`}
          </Text>
        ) : null}
      </BlockStack>
    </InlineStack>
  );
}

export default function DebugPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionResponse>();
  const running = fetcher.state !== "idle";

  // A manual run's fresh report replaces the stored one for this render.
  const report = fetcher.data?.ok
    ? (fetcher.data.report ?? data.report)
    : data.report;

  const byCategory = useMemo(() => {
    const groups = new Map<string, SelfCheckResult[]>();
    for (const check of report?.checks ?? []) {
      const list = groups.get(check.category) ?? [];
      list.push(check);
      groups.set(check.category, list);
    }
    const known = CATEGORY_ORDER.filter((c) => groups.has(c));
    const unknown = [...groups.keys()].filter(
      (c) => !CATEGORY_ORDER.includes(c as (typeof CATEGORY_ORDER)[number]),
    );
    return [...known, ...unknown].map((category) => ({
      category,
      checks: groups.get(category) ?? [],
    }));
  }, [report]);

  const failing = (report?.checks ?? []).filter((c) => c.status === "FAIL");
  const verdictBadge = report ? VERDICT_BADGES[report.verdict] : null;

  return (
    <Page
      title="Debug"
      subtitle="Live self-checks of billing, retries, the customer portal, webhooks, jobs and configuration — probed on the deployed store, not assumed from local behavior."
      primaryAction={
        <Button
          variant="primary"
          loading={running}
          onClick={() => fetcher.submit({ intent: "run" }, { method: "post" })}
        >
          Run all checks now
        </Button>
      }
    >
      <BlockStack gap="400">
        {fetcher.data && !fetcher.data.ok ? (
          <Banner tone="critical" title="Self-check could not run">
            <p>{fetcher.data.error}</p>
          </Banner>
        ) : null}

        {report && report.verdict === "BROKEN" ? (
          <Banner
            tone="critical"
            title={`${failing.length} check(s) failing — the live store is affected`}
          >
            <BlockStack gap="100">
              {failing.map((check) => (
                <Text key={check.key} as="p" variant="bodySm">
                  {`${check.label}: ${check.detail}`}
                </Text>
              ))}
            </BlockStack>
          </Banner>
        ) : null}

        <Card>
          <BlockStack gap="200">
            <InlineStack gap="200" blockAlign="center">
              {verdictBadge ? (
                <Badge tone={verdictBadge.tone}>{verdictBadge.label}</Badge>
              ) : (
                <Badge>Not yet run</Badge>
              )}
              {report ? (
                <Text as="p" variant="bodySm" tone="subdued">
                  {`Last run ${agoLabel(report.ranAt)} (${report.trigger === "job" ? "automatic" : "manual"}, ${report.tookMs}ms): ${report.passCount} pass · ${report.warnCount} check · ${report.failCount} fail · ${report.skipCount} skipped.`}
                </Text>
              ) : (
                <Text as="p" variant="bodySm" tone="subdued">
                  The first automatic run happens within 30 minutes of the app
                  starting — or run it now.
                </Text>
              )}
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              The suite re-runs automatically every 30 minutes. A failing run
              raises one critical alert (emailed to the addresses on Settings →
              Monitoring &amp; alerting) and resolves it automatically once a
              later run comes back clean. Storefront-render diagnosis for a
              specific product lives on{" "}
              <PolarisLink url="/app/preview">Preview &amp; launch</PolarisLink>{" "}
              (Preview Doctor); raised alerts live on{" "}
              <PolarisLink url="/app/alerts">Alerts</PolarisLink>.
            </Text>
          </BlockStack>
        </Card>

        {byCategory.map(({ category, checks }) => (
          <Card key={category}>
            <BlockStack gap="300">
              <Text as="h2" variant="headingSm">
                {category}
              </Text>
              <BlockStack gap="300">
                {checks.map((check) => (
                  <CheckRow key={check.key} check={check} />
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        ))}
      </BlockStack>
    </Page>
  );
}
