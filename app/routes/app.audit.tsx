import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  IndexTable,
  InlineStack,
  Page,
  Pagination,
  Popover,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import type { Prisma, SubscriberEvent } from "@prisma/client";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { logEvent } from "~/lib/events/log.server";

/**
 * Admin — Audit browser over the SubscriberEvent log (the single source for
 * timeline, audit and compliance). Filter by canonical category, source,
 * email and date range; export the current filter to CSV (capped 5000 rows).
 */

const PAGE_SIZE = 50;
const EXPORT_CAP = 5000;

const CATEGORIES = [
  "contract",
  "cycle",
  "billing",
  "dunning",
  "cancel",
  "winback",
  "lifecycle",
  "notification",
  "portal",
  "magic",
  "admin",
  "import",
  "stockout",
  "alert",
  "shop",
] as const;

const SOURCES = [
  "SYSTEM",
  "WEBHOOK",
  "ADMIN",
  "CUSTOMER_PORTAL",
  "MAGIC_LINK",
  "SCHEDULER",
  "KLAVIYO",
] as const;

// ── Shared filter parsing (loader + export action) ───────────────────────────

interface AuditFilters {
  category: string;
  source: string;
  email: string;
  from: string;
  to: string;
}

function readFilters(params: URLSearchParams | FormData): AuditFilters {
  const get = (key: string): string => {
    const v = params.get(key);
    return typeof v === "string" ? v.trim() : "";
  };
  return {
    category: get("category"),
    source: get("source"),
    email: get("email"),
    from: get("from"),
    to: get("to"),
  };
}

function buildWhere(
  shopId: string,
  filters: AuditFilters,
): Prisma.SubscriberEventWhereInput {
  const where: Prisma.SubscriberEventWhereInput = { shopId };
  if (filters.category && (CATEGORIES as readonly string[]).includes(filters.category)) {
    where.type = { startsWith: `${filters.category}.` };
  }
  if (filters.source && (SOURCES as readonly string[]).includes(filters.source)) {
    where.source = filters.source;
  }
  if (filters.email) {
    where.email = { contains: filters.email, mode: "insensitive" };
  }
  const createdAt: Prisma.DateTimeFilter = {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(filters.from)) {
    createdAt.gte = new Date(`${filters.from}T00:00:00.000Z`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(filters.to)) {
    // Inclusive end-of-day.
    createdAt.lt = new Date(
      new Date(`${filters.to}T00:00:00.000Z`).getTime() + 24 * 3600 * 1000,
    );
  }
  if (createdAt.gte || createdAt.lt) where.createdAt = createdAt;
  return where;
}

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }

  const url = new URL(request.url);
  const filters = readFilters(url.searchParams);
  const cursorParam = url.searchParams.get("cursor");
  const dir = url.searchParams.get("dir") === "prev" ? "prev" : "next";

  const where = buildWhere(shop.id, filters);

  const cursor = cursorParam ? new Date(cursorParam) : null;
  const validCursor = cursor && !Number.isNaN(cursor.getTime()) ? cursor : null;

  let events: SubscriberEvent[] = [];
  let hasNext = false;
  let hasPrevious = false;

  if (!validCursor) {
    events = await prisma.subscriberEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE + 1,
    });
    hasNext = events.length > PAGE_SIZE;
    events = events.slice(0, PAGE_SIZE);
  } else if (dir === "next") {
    events = await prisma.subscriberEvent.findMany({
      where: { ...where, createdAt: { ...(where.createdAt as object), lt: validCursor } },
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE + 1,
    });
    hasNext = events.length > PAGE_SIZE;
    hasPrevious = true;
    events = events.slice(0, PAGE_SIZE);
  } else {
    events = await prisma.subscriberEvent.findMany({
      where: { ...where, createdAt: { ...(where.createdAt as object), gt: validCursor } },
      orderBy: { createdAt: "asc" },
      take: PAGE_SIZE + 1,
    });
    hasPrevious = events.length > PAGE_SIZE;
    hasNext = true;
    events = events.slice(0, PAGE_SIZE).reverse();
  }

  return json({
    filters,
    hasNext,
    hasPrevious,
    nextCursor: events.length
      ? events[events.length - 1].createdAt.toISOString()
      : null,
    prevCursor: events.length ? events[0].createdAt.toISOString() : null,
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      source: e.source,
      actor: e.actor,
      email: e.email,
      contractId: e.contractId,
      createdAt: e.createdAt.toISOString(),
      payloadJson: JSON.stringify(e.payload ?? {}, null, 2),
    })),
  });
};

// ── Action (CSV export of the current filter) ────────────────────────────────

interface ActionResponse {
  ok: boolean;
  intent: string;
  message?: string;
  error?: string;
  csv?: string;
  filename?: string;
}

function actorFromSession(session: {
  shop: string;
  onlineAccessInfo?: { associated_user?: { email?: string | null } } | null;
}): string {
  return session.onlineAccessInfo?.associated_user?.email ?? `admin@${session.shop}`;
}

function csvEscape(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
    if (intent !== "exportCsv") {
      return json<ActionResponse>({ ok: false, intent, error: `Unknown intent: ${intent}` });
    }

    const filters = readFilters(formData);
    const where = buildWhere(shop.id, filters);
    const events = await prisma.subscriberEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: EXPORT_CAP,
    });

    const header = [
      "createdAt",
      "type",
      "source",
      "actor",
      "email",
      "contractId",
      "customerId",
      "payload",
    ];
    const lines = events.map((e) =>
      [
        e.createdAt.toISOString(),
        e.type,
        e.source,
        e.actor ?? "",
        e.email ?? "",
        e.contractId ?? "",
        e.customerId ?? "",
        JSON.stringify(e.payload ?? {}),
      ]
        .map(csvEscape)
        .join(","),
    );
    const csv = [header.join(","), ...lines].join("\n");

    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "ADMIN",
      actor,
      payload: {
        description: `Exported ${events.length} audit events to CSV`,
        action: "audit_csv_export",
        filters: { ...filters },
        rowCount: events.length,
        cap: EXPORT_CAP,
      },
    });

    return json<ActionResponse>({
      ok: true,
      intent,
      csv,
      filename: `audit-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`,
      message: `Exported ${events.length} events${events.length === EXPORT_CAP ? " (cap reached)" : ""}`,
    });
  } catch (err) {
    console.error("[admin] audit export failed", err);
    return json<ActionResponse>({
      ok: false,
      intent,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

// ── Component ────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function categoryTone(
  category: string,
): "success" | "attention" | "critical" | "info" | "warning" | "new" {
  switch (category) {
    case "dunning":
      return "warning";
    case "cancel":
    case "alert":
      return "critical";
    case "billing":
      return "success";
    case "admin":
      return "attention";
    case "magic":
    case "portal":
      return "new";
    default:
      return "info";
  }
}

function downloadTextFile(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function AuditPage() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const exportFetcher = useFetcher<typeof action>();

  const [emailInput, setEmailInput] = useState(data.filters.email);
  const [activePayloadId, setActivePayloadId] = useState<string | null>(null);
  const downloadedRef = useRef<string | null>(null);

  const setParam = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(updates)) {
        if (value == null || value === "") next.delete(key);
        else next.set(key, value);
      }
      // Any filter change resets pagination.
      next.delete("cursor");
      next.delete("dir");
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // Debounced email filter.
  useEffect(() => {
    const handle = setTimeout(() => {
      if (emailInput !== data.filters.email) {
        setParam({ email: emailInput || null });
      }
    }, 400);
    return () => clearTimeout(handle);
  }, [emailInput, data.filters.email, setParam]);

  useEffect(() => {
    const d = exportFetcher.data;
    if (
      exportFetcher.state === "idle" &&
      d?.ok &&
      d.csv &&
      d.filename &&
      downloadedRef.current !== d.filename
    ) {
      downloadedRef.current = d.filename;
      downloadTextFile(d.csv, d.filename);
    }
  }, [exportFetcher.state, exportFetcher.data]);

  const goToPage = (dir: "next" | "prev") => {
    const next = new URLSearchParams(searchParams);
    const cursor = dir === "next" ? data.nextCursor : data.prevCursor;
    if (!cursor) return;
    next.set("cursor", cursor);
    next.set("dir", dir);
    setSearchParams(next, { replace: true });
  };

  const lastResult = exportFetcher.data;

  return (
    <Page title="Audit log" subtitle="Every subscriber-affecting event" fullWidth>
      <BlockStack gap="400">
        {lastResult && !lastResult.ok && lastResult.error ? (
          <Banner tone="critical" title="Export failed">
            <p>{lastResult.error}</p>
          </Banner>
        ) : null}

        <Card padding="0">
          <Box padding="300">
            <InlineStack gap="300" blockAlign="end" wrap>
              <Box minWidth="160px">
                <Select
                  label="Category"
                  options={[
                    { label: "All categories", value: "" },
                    ...CATEGORIES.map((c) => ({ label: c, value: c })),
                  ]}
                  value={data.filters.category}
                  onChange={(v) => setParam({ category: v || null })}
                />
              </Box>
              <Box minWidth="180px">
                <Select
                  label="Source"
                  options={[
                    { label: "All sources", value: "" },
                    ...SOURCES.map((s) => ({ label: s, value: s })),
                  ]}
                  value={data.filters.source}
                  onChange={(v) => setParam({ source: v || null })}
                />
              </Box>
              <Box minWidth="220px">
                <TextField
                  label="Email"
                  value={emailInput}
                  onChange={setEmailInput}
                  autoComplete="off"
                  placeholder="Search by email"
                />
              </Box>
              <TextField
                label="From"
                type="date"
                value={data.filters.from}
                onChange={(v) => setParam({ from: v || null })}
                autoComplete="off"
              />
              <TextField
                label="To"
                type="date"
                value={data.filters.to}
                onChange={(v) => setParam({ to: v || null })}
                autoComplete="off"
              />
              <Button
                loading={exportFetcher.state !== "idle"}
                onClick={() =>
                  exportFetcher.submit(
                    { intent: "exportCsv", ...data.filters },
                    { method: "post" },
                  )
                }
              >
                Export CSV
              </Button>
            </InlineStack>
          </Box>

          <IndexTable
            resourceName={{ singular: "event", plural: "events" }}
            itemCount={data.events.length}
            selectable={false}
            headings={[
              { title: "When" },
              { title: "Type" },
              { title: "Source" },
              { title: "Actor" },
              { title: "Email" },
              { title: "Contract" },
              { title: "Payload" },
            ]}
          >
            {data.events.map((row, index) => {
              const category = row.type.split(".")[0] ?? "other";
              return (
                <IndexTable.Row id={row.id} key={row.id} position={index}>
                  <IndexTable.Cell>
                    <span title={row.createdAt}>{timeAgo(row.createdAt)}</span>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <InlineStack gap="100" blockAlign="center" wrap={false}>
                      <Badge tone={categoryTone(category)}>{category}</Badge>
                      <Text as="span" variant="bodySm">
                        {row.type}
                      </Text>
                    </InlineStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>{row.source}</IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {row.actor ?? "–"}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {row.email ?? "–"}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {row.contractId ? (
                      <Button
                        variant="plain"
                        size="micro"
                        onClick={() =>
                          navigate(`/app/subscribers/${row.contractId}`)
                        }
                      >
                        View
                      </Button>
                    ) : (
                      "–"
                    )}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Popover
                      active={activePayloadId === row.id}
                      onClose={() => setActivePayloadId(null)}
                      activator={
                        <Button
                          size="micro"
                          variant="plain"
                          onClick={() =>
                            setActivePayloadId(
                              activePayloadId === row.id ? null : row.id,
                            )
                          }
                        >
                          Payload
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
                          {row.payloadJson}
                        </pre>
                      </Box>
                    </Popover>
                  </IndexTable.Cell>
                </IndexTable.Row>
              );
            })}
          </IndexTable>

          <Box padding="300">
            <InlineStack align="center">
              <Pagination
                hasPrevious={data.hasPrevious}
                hasNext={data.hasNext}
                onPrevious={() => goToPage("prev")}
                onNext={() => goToPage("next")}
              />
            </InlineStack>
          </Box>
        </Card>
      </BlockStack>
    </Page>
  );
}
