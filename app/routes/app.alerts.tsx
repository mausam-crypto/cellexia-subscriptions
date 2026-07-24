import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, useSearchParams } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  IndexTable,
  Page,
  Popover,
  Tabs,
  Text,
  useIndexResourceState,
} from "@shopify/polaris";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { logEvent } from "~/lib/events/log.server";

/**
 * Admin — Operational alerts. Open + resolved tabs, severity badges, raw
 * context popovers, single and bulk resolve. Alerts are raised by the
 * monitoring jobs (billing run failures, webhook failures, churn/failure
 * spikes, stuck contracts, stockouts).
 */

const TABS = [
  { id: "open", content: "Open" },
  { id: "resolved", content: "Resolved" },
] as const;

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }

  const url = new URL(request.url);
  const tab = url.searchParams.get("tab") === "resolved" ? "resolved" : "open";

  const alerts = await prisma.alert.findMany({
    where: {
      shopId: shop.id,
      resolvedAt: tab === "open" ? null : { not: null },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const openCount = await prisma.alert.count({
    where: { shopId: shop.id, resolvedAt: null },
  });

  return json({
    tab,
    openCount,
    alerts: alerts.map((a) => ({
      id: a.id,
      type: a.type,
      severity: a.severity,
      message: a.message,
      contextJson: JSON.stringify(a.context ?? {}, null, 2),
      createdAt: a.createdAt.toISOString(),
      resolvedAt: a.resolvedAt?.toISOString() ?? null,
    })),
  });
};

// ── Action ───────────────────────────────────────────────────────────────────

interface ActionResponse {
  ok: boolean;
  intent: string;
  message?: string;
  error?: string;
}

function actorFromSession(session: {
  shop: string;
  onlineAccessInfo?: { associated_user?: { email?: string | null } } | null;
}): string {
  return session.onlineAccessInfo?.associated_user?.email ?? `admin@${session.shop}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseIds(raw: FormDataEntryValue | null): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // fall through
  }
  return [];
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }
  const actor = actorFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  try {
    if (intent === "resolve") {
      const id = String(formData.get("id") ?? "");
      const alert = await prisma.alert.findFirst({
        where: { id, shopId: shop.id },
      });
      if (!alert) {
        return json<ActionResponse>({ ok: false, intent, error: "Alert not found" });
      }
      if (!alert.resolvedAt) {
        await prisma.alert.update({
          where: { id: alert.id },
          data: { resolvedAt: new Date() },
        });
        await logEvent({
          shopId: shop.id,
          type: "admin.action",
          source: "ADMIN",
          actor,
          payload: {
            description: `Resolved alert ${alert.type}: ${alert.message}`,
            action: "resolve_alert",
            alertId: alert.id,
            alertType: alert.type,
            severity: alert.severity,
          },
        });
      }
      return json<ActionResponse>({ ok: true, intent, message: "Alert resolved" });
    }

    if (intent === "bulkResolve") {
      const ids = parseIds(formData.get("ids"));
      if (ids.length === 0) {
        return json<ActionResponse>({ ok: false, intent, error: "No alerts selected" });
      }
      const result = await prisma.alert.updateMany({
        where: { id: { in: ids }, shopId: shop.id, resolvedAt: null },
        data: { resolvedAt: new Date() },
      });
      await logEvent({
        shopId: shop.id,
        type: "admin.action",
        source: "ADMIN",
        actor,
        payload: {
          description: `Bulk resolved ${result.count} alert(s)`,
          action: "bulk_resolve_alerts",
          alertIds: ids,
          resolvedCount: result.count,
        },
      });
      return json<ActionResponse>({
        ok: true,
        intent,
        message: `Resolved ${result.count} alert(s)`,
      });
    }

    return json<ActionResponse>({ ok: false, intent, error: `Unknown intent: ${intent}` });
  } catch (err) {
    console.error("[admin] alerts action failed", intent, err);
    return json<ActionResponse>({ ok: false, intent, error: errMessage(err) });
  }
};

// ── Component ────────────────────────────────────────────────────────────────

function severityTone(severity: string): "critical" | "warning" | "info" {
  switch (severity) {
    case "CRITICAL":
      return "critical";
    case "WARNING":
      return "warning";
    default:
      return "info";
  }
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AlertsPage() {
  const data = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  const [activeContextId, setActiveContextId] = useState<string | null>(null);

  const rows = data.alerts;
  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } =
    useIndexResourceState(rows);

  const busy = fetcher.state !== "idle";
  const selectedTabIndex = data.tab === "resolved" ? 1 : 0;

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      clearSelection();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const lastResult = fetcher.data;

  return (
    <Page
      title="Alerts"
      subtitle={`${data.openCount} open alert(s)`}
      fullWidth
    >
      <BlockStack gap="400">
        {lastResult && !lastResult.ok && lastResult.error ? (
          <Banner tone="critical" title="Action failed">
            <p>{lastResult.error}</p>
          </Banner>
        ) : null}
        {lastResult && lastResult.ok && lastResult.message ? (
          <Banner tone="success">
            <p>{lastResult.message}</p>
          </Banner>
        ) : null}

        <Card padding="0">
          <Tabs
            tabs={TABS.map((t) => ({ id: t.id, content: t.content }))}
            selected={selectedTabIndex}
            onSelect={(index) => {
              const next = new URLSearchParams();
              if (index === 1) next.set("tab", "resolved");
              setSearchParams(next, { replace: true });
            }}
          />
          <IndexTable
            resourceName={{ singular: "alert", plural: "alerts" }}
            itemCount={rows.length}
            selectable={data.tab === "open"}
            selectedItemsCount={
              allResourcesSelected ? "All" : selectedResources.length
            }
            onSelectionChange={handleSelectionChange}
            loading={busy}
            promotedBulkActions={
              data.tab === "open"
                ? [
                    {
                      content: "Resolve selected",
                      onAction: () =>
                        fetcher.submit(
                          {
                            intent: "bulkResolve",
                            ids: JSON.stringify(selectedResources),
                          },
                          { method: "post" },
                        ),
                    },
                  ]
                : []
            }
            headings={[
              { title: "Severity" },
              { title: "Type" },
              { title: "Message" },
              { title: "Raised" },
              { title: data.tab === "open" ? "Actions" : "Resolved" },
            ]}
          >
            {rows.map((row, index) => (
              <IndexTable.Row
                id={row.id}
                key={row.id}
                position={index}
                selected={selectedResources.includes(row.id)}
              >
                <IndexTable.Cell>
                  <Badge tone={severityTone(row.severity)}>{row.severity}</Badge>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Text as="span" variant="bodySm" fontWeight="semibold">
                    {row.type}
                  </Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Box maxWidth="480px">
                    <Text as="span" variant="bodySm" truncate>
                      {row.message}
                    </Text>
                  </Box>
                </IndexTable.Cell>
                <IndexTable.Cell>{formatDateTime(row.createdAt)}</IndexTable.Cell>
                <IndexTable.Cell>
                  <Box>
                    <Popover
                      active={activeContextId === row.id}
                      onClose={() => setActiveContextId(null)}
                      activator={
                        <Button
                          size="micro"
                          variant="plain"
                          onClick={() =>
                            setActiveContextId(
                              activeContextId === row.id ? null : row.id,
                            )
                          }
                        >
                          Context
                        </Button>
                      }
                    >
                      <Box padding="300" maxWidth="420px">
                        <pre
                          style={{
                            margin: 0,
                            fontSize: 11,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}
                        >
                          {row.contextJson}
                        </pre>
                      </Box>
                    </Popover>{" "}
                    {data.tab === "open" ? (
                      <Button
                        size="slim"
                        disabled={busy}
                        onClick={() =>
                          fetcher.submit(
                            { intent: "resolve", id: row.id },
                            { method: "post" },
                          )
                        }
                      >
                        Resolve
                      </Button>
                    ) : (
                      <Text as="span" variant="bodySm" tone="subdued">
                        {row.resolvedAt ? formatDateTime(row.resolvedAt) : "–"}
                      </Text>
                    )}
                  </Box>
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        </Card>
      </BlockStack>
    </Page>
  );
}
