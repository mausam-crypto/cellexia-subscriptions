/**
 * [subscribers] — admin subscriber list.
 *
 * Filterable, paginated IndexTable of SubscriptionContract mirrors with
 * summary cards on top. Row click opens the CS console
 * (app.subscribers.$id.tsx). Read access: OWNER / ADMIN / CS_AGENT.
 */
import { useState } from "react";
import type { FormEvent } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  EmptyState,
  IndexTable,
  InlineGrid,
  InlineStack,
  Page,
  Pagination,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import type { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { requireRole } from "~/services/core/rbac.server";
import { formatMoney } from "~/lib/money";
import { CONTRACT_STATUSES, DUNNING_PHASES } from "~/types/domain";
import {
  ACTIVE_DUNNING_PHASES,
  CHURN_BAND_FILTERS,
  cadenceLabel,
  churnBand,
  churnBandTone,
  churnScoreRange,
  dunningTone,
  humanizeEnum,
  linesSummary,
  NEXT_BILLING_WINDOWS,
  nextBillingRange,
  parseSubscriberFilters,
  qualityTone,
  scoreOutOf100,
  statusTone,
} from "~/services/subscribers/actions";

const PAGE_SIZE = 25;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireRole(session, "OWNER", "ADMIN", "CS_AGENT");
  const shop = session.shop;

  const url = new URL(request.url);
  const filters = parseSubscriberFilters(url.searchParams);
  const now = new Date();

  const where: Prisma.SubscriptionContractWhereInput = { shop };
  if (filters.status) where.status = filters.status;
  if (filters.email) where.customerEmail = { contains: filters.email };
  if (filters.churnBand) where.churnRiskScore = churnScoreRange(filters.churnBand);
  if (filters.dunningPhase) where.dunningState = { phase: filters.dunningPhase };
  if (filters.window) where.nextBillingDate = nextBillingRange(filters.window, now);

  const [contracts, total, activeCount, pausedCount, dunningCount, highRiskCount] =
    await Promise.all([
      prisma.subscriptionContract.findMany({
        where,
        include: { lines: true, dunningState: true },
        orderBy: { updatedAt: "desc" },
        skip: (filters.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      prisma.subscriptionContract.count({ where }),
      prisma.subscriptionContract.count({ where: { shop, status: "ACTIVE" } }),
      prisma.subscriptionContract.count({ where: { shop, status: "PAUSED" } }),
      prisma.subscriptionContract.count({
        where: { shop, dunningState: { phase: { in: [...ACTIVE_DUNNING_PHASES] } } },
      }),
      prisma.subscriptionContract.count({
        where: { shop, status: "ACTIVE", churnRiskScore: churnScoreRange("HIGH") },
      }),
    ]);

  return json({
    rows: contracts.map((c) => ({
      id: c.id,
      email: c.customerEmail,
      customerId: c.shopifyCustomerId,
      status: c.status,
      products: linesSummary(c.lines),
      intervalWeeks: c.intervalWeeks,
      nextBillingDate: c.nextBillingDate,
      successfulOrders: c.successfulOrders,
      revenueCents: c.totalRevenueCents,
      currencyCode: c.currencyCode,
      qualityScore: c.qualityScore,
      churnRiskScore: c.churnRiskScore,
      dunningPhase: c.dunningState?.phase ?? "NONE",
    })),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    summary: {
      active: activeCount,
      paused: pausedCount,
      dunning: dunningCount,
      highRisk: highRiskCount,
    },
    appliedFilters: {
      status: filters.status ?? "ALL",
      band: filters.churnBand ?? "ALL",
      phase: filters.dunningPhase ?? "ALL",
      window: filters.window ?? "ALL",
      email: filters.email ?? "",
    },
  });
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <Text as="p" variant="headingLg">
          {String(value)}
        </Text>
      </BlockStack>
    </Card>
  );
}

export default function SubscribersPage() {
  const { rows, total, page, pageCount, summary, appliedFilters } =
    useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [email, setEmail] = useState(appliedFilters.email);
  const [status, setStatus] = useState(appliedFilters.status);
  const [band, setBand] = useState(appliedFilters.band);
  const [phase, setPhase] = useState(appliedFilters.phase);
  const [billingWindow, setBillingWindow] = useState(appliedFilters.window);

  const statusOptions = [
    { label: "All statuses", value: "ALL" },
    ...CONTRACT_STATUSES.map((s) => ({ label: humanizeEnum(s), value: s })),
  ];
  const bandOptions = [
    { label: "All churn risk", value: "ALL" },
    ...CHURN_BAND_FILTERS.map((b) => ({ label: `${humanizeEnum(b)} risk`, value: b })),
  ];
  const phaseOptions = [
    { label: "All recovery phases", value: "ALL" },
    ...DUNNING_PHASES.map((p) => ({ label: humanizeEnum(p), value: p })),
  ];
  const windowLabels: Record<string, string> = {
    OVERDUE: "Overdue",
    NEXT_7_DAYS: "Next 7 days",
    NEXT_14_DAYS: "Next 14 days",
    NEXT_30_DAYS: "Next 30 days",
  };
  const windowOptions = [
    { label: "Any billing date", value: "ALL" },
    ...NEXT_BILLING_WINDOWS.map((w) => ({ label: windowLabels[w] ?? w, value: w })),
  ];

  const applyFilters = (e?: FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    const p = new URLSearchParams();
    if (email.trim() !== "") p.set("email", email.trim());
    if (status !== "ALL") p.set("status", status);
    if (band !== "ALL") p.set("band", band);
    if (phase !== "ALL") p.set("phase", phase);
    if (billingWindow !== "ALL") p.set("window", billingWindow);
    setSearchParams(p);
  };

  const clearFilters = () => {
    setEmail("");
    setStatus("ALL");
    setBand("ALL");
    setPhase("ALL");
    setBillingWindow("ALL");
    setSearchParams(new URLSearchParams());
  };

  const goToPage = (n: number) => {
    const p = new URLSearchParams(searchParams);
    p.set("page", String(n));
    setSearchParams(p);
  };

  const now = Date.now();

  return (
    <Page
      title="Subscribers"
      subtitle="Continuous treatment plans across your store"
      fullWidth
    >
      <BlockStack gap="400">
        <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
          <SummaryCard label="Active plans" value={summary.active} />
          <SummaryCard label="Paused" value={summary.paused} />
          <SummaryCard label="In payment recovery" value={summary.dunning} />
          <SummaryCard label="High churn risk" value={summary.highRisk} />
        </InlineGrid>

        <Card>
          <form onSubmit={applyFilters}>
            <BlockStack gap="300">
              <InlineGrid columns={{ xs: 1, sm: 2, lg: 5 }} gap="300">
                <TextField
                  label="Search email"
                  value={email}
                  onChange={setEmail}
                  autoComplete="off"
                  placeholder="customer@example.com"
                />
                <Select
                  label="Status"
                  options={statusOptions}
                  value={status}
                  onChange={setStatus}
                />
                <Select
                  label="Churn risk"
                  options={bandOptions}
                  value={band}
                  onChange={setBand}
                />
                <Select
                  label="Payment recovery"
                  options={phaseOptions}
                  value={phase}
                  onChange={setPhase}
                />
                <Select
                  label="Next billing"
                  options={windowOptions}
                  value={billingWindow}
                  onChange={setBillingWindow}
                />
              </InlineGrid>
              <InlineStack gap="200">
                <Button submit variant="primary">
                  Apply filters
                </Button>
                <Button onClick={clearFilters}>Clear</Button>
                <Box paddingBlockStart="150">
                  <Text as="span" variant="bodySm" tone="subdued">
                    {total} {total === 1 ? "plan" : "plans"} match
                  </Text>
                </Box>
              </InlineStack>
            </BlockStack>
          </form>
        </Card>

        <Card padding="0">
          {rows.length === 0 ? (
            <EmptyState
              heading="No treatment plans match these filters"
              action={{ content: "Clear filters", onAction: clearFilters }}
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>Try a broader status, risk band or billing window.</p>
            </EmptyState>
          ) : (
            <>
              <IndexTable
                resourceName={{ singular: "subscriber", plural: "subscribers" }}
                itemCount={rows.length}
                selectable={false}
                headings={[
                  { title: "Customer" },
                  { title: "Status" },
                  { title: "Products" },
                  { title: "Cadence" },
                  { title: "Next billing" },
                  { title: "Orders" },
                  { title: "Revenue" },
                  { title: "Quality" },
                  { title: "Churn risk" },
                ]}
              >
                {rows.map((row, index) => {
                  const band = churnBand(row.churnRiskScore);
                  const overdue =
                    row.status === "ACTIVE" &&
                    row.nextBillingDate !== null &&
                    new Date(row.nextBillingDate).getTime() < now;
                  const inDunning = (ACTIVE_DUNNING_PHASES as readonly string[]).includes(
                    row.dunningPhase,
                  );
                  return (
                    <IndexTable.Row
                      id={row.id}
                      key={row.id}
                      position={index}
                      onClick={() => navigate(`/app/subscribers/${row.id}`)}
                    >
                      <IndexTable.Cell>
                        <BlockStack gap="100">
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            {row.email ?? "No email on file"}
                          </Text>
                          {inDunning ? (
                            <InlineStack gap="100">
                              <Badge tone={dunningTone(row.dunningPhase)} size="small">
                                {humanizeEnum(row.dunningPhase)}
                              </Badge>
                            </InlineStack>
                          ) : null}
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Badge tone={statusTone(row.status)}>
                          {humanizeEnum(row.status)}
                        </Badge>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" variant="bodySm">
                          {row.products}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>{cadenceLabel(row.intervalWeeks)}</IndexTable.Cell>
                      <IndexTable.Cell>
                        <InlineStack gap="100" blockAlign="center">
                          <Text as="span" variant="bodySm">
                            {fmtDate(row.nextBillingDate)}
                          </Text>
                          {overdue ? (
                            <Badge tone="critical" size="small">
                              Overdue
                            </Badge>
                          ) : null}
                        </InlineStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>{row.successfulOrders}</IndexTable.Cell>
                      <IndexTable.Cell>
                        {formatMoney({
                          amountCents: row.revenueCents,
                          currencyCode: row.currencyCode,
                        })}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {row.qualityScore !== null ? (
                          <Badge tone={qualityTone(row.qualityScore)}>
                            {String(scoreOutOf100(row.qualityScore))}
                          </Badge>
                        ) : (
                          <Text as="span" tone="subdued">
                            —
                          </Text>
                        )}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {row.churnRiskScore !== null ? (
                          <Badge tone={churnBandTone(band)}>
                            {`${humanizeEnum(band)} · ${scoreOutOf100(row.churnRiskScore)}`}
                          </Badge>
                        ) : (
                          <Text as="span" tone="subdued">
                            —
                          </Text>
                        )}
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );
                })}
              </IndexTable>
              <Box padding="400">
                <InlineStack align="center">
                  <Pagination
                    hasPrevious={page > 1}
                    onPrevious={() => goToPage(page - 1)}
                    hasNext={page < pageCount}
                    onNext={() => goToPage(page + 1)}
                    label={`Page ${page} of ${pageCount}`}
                  />
                </InlineStack>
              </Box>
            </>
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
