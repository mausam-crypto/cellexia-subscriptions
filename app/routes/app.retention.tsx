/**
 * [retention] Admin — cancellation-flow report, churn-risk list with
 * one-click proactive actions, model-health transparency (learned
 * calibration, Brier trend, learned dunning offsets), pause design settings
 * and the save-offer hierarchy reference.
 */
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  DataTable,
  InlineStack,
  Layout,
  List,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import prisma from "~/db.server";
import { addDays, isoDate } from "~/lib/dates";
import { formatMoney } from "~/lib/money";
import { authenticate } from "~/shopify.server";
import { appendAudit } from "~/services/audit.server";
import { requireRole } from "~/services/core/rbac.server";
import type { AdminGraphql } from "~/services/core/shopifyClient.server";
import {
  AlreadyPausedError,
  delayByWeeks,
  pauseUntil,
  switchCadence,
} from "~/services/core/contracts.server";
import { DEFAULT_CHURN_THRESHOLD } from "~/services/retention/churn.server";
import {
  CHURN_MEDIUM_THRESHOLD,
  MAX_INTERVAL_WEEKS,
} from "~/services/subscribers/actions";
import { getModelState } from "~/services/analytics/learning.server";
import type { CalibrationBucket } from "~/services/analytics/learning.server";
import {
  CANCEL_REASONS,
  PAUSE_OPTIONS_DAYS,
  SAVE_OFFER_TYPES,
  parseJson,
} from "~/types/domain";

// ─────────────────────────────── Loader ───────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireRole(session, "OWNER", "ADMIN");
  const shop = session.shop;

  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  const currencyCode = settings?.currencyCode ?? "EUR";
  const settingsObj = parseJson<Record<string, unknown>>(
    settings?.settingsJson,
    {},
  );
  const rawThreshold = Number(settingsObj.churnRiskThreshold);
  const churnThreshold =
    Number.isFinite(rawThreshold) && rawThreshold > 0 && rawThreshold < 1
      ? rawThreshold
      : DEFAULT_CHURN_THRESHOLD;

  // Cancellation-flow report: reason × outcome counts.
  const sessions = await prisma.cancellationSession.findMany({
    where: { shop },
    select: { reason: true, outcome: true, saveCostCents: true },
  });

  const byReason = new Map<
    string,
    { started: number; saved: number; cancelled: number; abandoned: number }
  >();
  let totalSaved = 0;
  let totalCancelled = 0;
  let saveCostSumCents = 0;
  let saveCostCount = 0;

  for (const s of sessions) {
    const reason = s.reason ?? "(no reason given)";
    const row = byReason.get(reason) ?? {
      started: 0,
      saved: 0,
      cancelled: 0,
      abandoned: 0,
    };
    row.started++;
    if (s.outcome === "SAVED") {
      row.saved++;
      totalSaved++;
      if (s.saveCostCents != null) {
        saveCostSumCents += s.saveCostCents;
        saveCostCount++;
      }
    } else if (s.outcome === "CANCELLED") {
      row.cancelled++;
      totalCancelled++;
    } else if (s.outcome === "ABANDONED") {
      row.abandoned++;
    }
    byReason.set(reason, row);
  }

  const reasonOrder: string[] = [...CANCEL_REASONS, "(no reason given)"];
  const reasonRows = [...byReason.entries()]
    .sort(
      (a, b) => reasonOrder.indexOf(a[0]) - reasonOrder.indexOf(b[0]),
    )
    .map(([reason, r]) => {
      const resolved = r.saved + r.cancelled;
      const rate = resolved > 0 ? Math.round((r.saved / resolved) * 100) : null;
      return {
        reason,
        started: r.started,
        saved: r.saved,
        cancelled: r.cancelled,
        abandoned: r.abandoned,
        saveRate: rate == null ? "—" : `${rate}%`,
      };
    });

  const resolvedTotal = totalSaved + totalCancelled;
  const overallSaveRate =
    resolvedTotal > 0 ? Math.round((totalSaved / resolvedTotal) * 100) : null;
  const avgSaveCost =
    saveCostCount > 0
      ? formatMoney({
          amountCents: Math.round(saveCostSumCents / saveCostCount),
          currencyCode,
        })
      : "—";

  // Churn-risk list: PAUSED customers stay visible (paused-then-forgotten is
  // the highest-risk cohort), and the MEDIUM floor keeps healthy shops from
  // seeing warning badges on 10 perfectly happy subscribers.
  const scoredCount = await prisma.subscriptionContract.count({
    where: {
      shop,
      status: { in: ["ACTIVE", "PAUSED"] },
      churnRiskScore: { not: null },
    },
  });
  const atRisk = await prisma.subscriptionContract.findMany({
    where: {
      shop,
      status: { in: ["ACTIVE", "PAUSED"] },
      churnRiskScore: { gte: CHURN_MEDIUM_THRESHOLD },
    },
    orderBy: { churnRiskScore: "desc" },
    take: 10,
  });

  const now = new Date();
  const churnRows = await Promise.all(
    atRisk.map(async (c) => {
      const snapshot = await prisma.scoreSnapshot.findFirst({
        where: { contractId: c.id, kind: "CHURN_RISK" },
        orderBy: { computedAt: "desc" },
      });
      const factors = parseJson<Record<string, number>>(
        snapshot?.factorsJson,
        {},
      );
      const topFactors = Object.entries(factors)
        .filter(
          ([k, v]) =>
            !["baseline", "raw", "calibrated", "modelVersion"].includes(k) &&
            typeof v === "number" &&
            v > 0,
        )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k} +${v.toFixed(2)}`);
      const pauseOverdue =
        c.status === "PAUSED" &&
        c.pausedUntil != null &&
        c.pausedUntil.getTime() <= now.getTime();
      return {
        contractId: c.id,
        email: c.customerEmail ?? c.shopifyCustomerId,
        score: c.churnRiskScore ?? 0,
        status: c.status,
        pauseOverdue,
        intervalWeeks: c.intervalWeeks,
        atMaxCadence: c.intervalWeeks >= MAX_INTERVAL_WEEKS,
        nextBillingDate: c.nextBillingDate ? isoDate(c.nextBillingDate) : "—",
        topFactors,
      };
    }),
  );

  // Model health (LEARNING-DATA-V2 §1): calibration table, Brier trend,
  // learned dunning offsets, plain-language status.
  const churnModel = await getModelState(shop, "CHURN_CALIBRATION");
  const calibrationBuckets =
    (churnModel?.params.buckets as CalibrationBucket[] | undefined) ?? [];
  const calibrationRows = calibrationBuckets.map((b) => ({
    range: `${b.lo.toFixed(1)}–${b.hi.toFixed(1)}`,
    predicted: `${Math.round(((b.lo + b.hi) / 2) * 100)}%`,
    observed: `${Math.round(b.observed * 100)}%`,
    calibrated: `${Math.round(b.calibrated * 100)}%`,
    n: b.n,
  }));

  const calibrationVersions = await prisma.modelState.findMany({
    where: { shop, model: "CHURN_CALIBRATION" },
    orderBy: { version: "asc" },
  });
  const brierTrend = calibrationVersions.map((v) => {
    const metrics = parseJson<Record<string, unknown>>(v.metricsJson, {});
    const brier = Number(metrics.brier);
    return {
      version: v.version,
      computedAt: isoDate(v.computedAt),
      n: v.sampleSize,
      brier: Number.isFinite(brier) ? brier.toFixed(3) : "—",
    };
  });

  const dunningModel = await getModelState(shop, "DUNNING_RECOVERY");
  const learnedOffsets = Object.entries(
    (dunningModel?.params.offsets as Record<string, number[]> | undefined) ?? {},
  ).map(([category, offsets]) => ({
    category,
    offsets: offsets.join(", "),
  }));

  const modelStatus = churnModel
    ? `Learning active — ${churnModel.sampleSize} outcomes observed (model v${churnModel.version}).`
    : "Not enough history yet — using launch defaults; learning starts automatically as outcomes accumulate.";

  return json({
    reasonRows,
    summary: {
      totalSessions: sessions.length,
      overallSaveRate,
      avgSaveCost,
    },
    churnRows,
    scoredCount,
    churnThreshold,
    mediumFloor: CHURN_MEDIUM_THRESHOLD,
    maxIntervalWeeks: MAX_INTERVAL_WEEKS,
    modelHealth: {
      status: modelStatus,
      calibrationRows,
      brierTrend,
      learnedOffsets,
      dunningSampleSize: dunningModel?.sampleSize ?? 0,
    },
  });
};

// ─────────────────────────────── Action ───────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  await requireRole(session, "OWNER", "ADMIN");
  const shop = session.shop;
  const graphql = admin.graphql as unknown as AdminGraphql;

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  const staffEmail =
    session.onlineAccessInfo?.associated_user?.email ?? "admin";

  if (intent === "saveChurnThreshold") {
    const threshold = Number(form.get("churnThreshold"));
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
      return json(
        {
          ok: false,
          message: "Threshold must be a number between 0 and 1 (e.g. 0.55).",
        },
        400,
      );
    }
    const settings = await prisma.shopSettings.findUnique({ where: { shop } });
    const settingsObj = parseJson<Record<string, unknown>>(
      settings?.settingsJson,
      {},
    );
    settingsObj.churnRiskThreshold = threshold;
    await prisma.shopSettings.upsert({
      where: { shop },
      create: { shop, settingsJson: JSON.stringify(settingsObj) },
      update: { settingsJson: JSON.stringify(settingsObj) },
    });
    await appendAudit({
      shop,
      actorType: "STAFF",
      actorId: staffEmail,
      action: "CHURN_THRESHOLD_UPDATED",
      subjectType: "ShopSettings",
      subjectId: shop,
      payload: { churnRiskThreshold: threshold },
    });
    return json({
      ok: true,
      message: `Churn alert threshold saved (${Math.round(threshold * 100)}%).`,
    });
  }

  const contractId = String(form.get("contractId") ?? "");
  if (!contractId) return json({ ok: false, message: "Missing contract" }, 400);

  let message = "";
  try {
    if (intent === "delay4") {
      // source STAFF: a retention-driven delay must not raise the customer's
      // churn score (the scan counts only organic CUSTOMER schedule changes).
      await delayByWeeks(graphql, shop, contractId, 4, { source: "STAFF" });
      message = "Next delivery moved back four weeks.";
    } else if (intent === "pause30") {
      await pauseUntil(graphql, shop, contractId, addDays(new Date(), 30));
      message = "Treatment plan paused for 30 days.";
    } else if (intent === "slowCadence") {
      const current = Number(form.get("intervalWeeks"));
      if (Number.isFinite(current) && current >= MAX_INTERVAL_WEEKS) {
        return json(
          {
            ok: false,
            message: `Already at the slowest cadence (${MAX_INTERVAL_WEEKS} weeks).`,
          },
          400,
        );
      }
      const next = Math.min(
        MAX_INTERVAL_WEEKS,
        Number.isFinite(current) && current > 0 ? current + 2 : 6,
      );
      await switchCadence(graphql, shop, contractId, next);
      message = `Cadence switched to every ${next} weeks.`;
    } else {
      return json({ ok: false, message: "Unknown action" }, 400);
    }
  } catch (e) {
    if (e instanceof AlreadyPausedError) {
      return json({ ok: false, message: e.message }, 400);
    }
    throw e;
  }

  await appendAudit({
    shop,
    actorType: "STAFF",
    actorId: staffEmail,
    action: "RETENTION_PROACTIVE_ACTION",
    subjectType: "SubscriptionContract",
    subjectId: contractId,
    payload: { intent },
  });

  return json({ ok: true, message });
};

// ─────────────────────────────── UI ───────────────────────────────────────

const OFFER_TYPE_NOTES: Record<string, string> = {
  EDUCATION: "Guidance, expectations, routing — free (never counted as a save on its own)",
  CHANGE_DELIVERY_DATE: "Delay / skip / move a delivery — free",
  CHANGE_FREQUENCY: "Slower or faster cadence — free",
  CHANGE_QUANTITY: "Smaller amount per delivery — free",
  PRODUCT_SWAP: "Different product, same plan — free",
  REMOVE_ITEM: "Drop one product, keep the rest — free",
  TEMPORARY_PAUSE: "Bounded pause (30/60/90 days or a date)",
  ACCOUNT_CREDIT: "One-cycle credit — costs margin",
  FREE_GIFT: "Complimentary product — costs COGS (needs a configured gift variant)",
  TEMPORARY_DISCOUNT: "Short-term % off — costs margin",
  PERMANENT_DISCOUNT: "Never automated; manual approval only",
};

function riskTone(
  score: number,
  threshold: number,
): "critical" | "warning" | "attention" {
  if (score >= Math.max(threshold, 0.85)) return "critical";
  if (score >= threshold) return "warning";
  return "attention";
}

function ChurnActions({
  contractId,
  intervalWeeks,
  atMaxCadence,
}: {
  contractId: string;
  intervalWeeks: number;
  atMaxCadence: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  return (
    <InlineStack gap="200" wrap={false}>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="delay4" />
        <input type="hidden" name="contractId" value={contractId} />
        <Button submit size="slim" disabled={busy}>
          Delay 4 wks
        </Button>
      </fetcher.Form>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="pause30" />
        <input type="hidden" name="contractId" value={contractId} />
        <Button submit size="slim" disabled={busy}>
          Pause 30 d
        </Button>
      </fetcher.Form>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="slowCadence" />
        <input type="hidden" name="contractId" value={contractId} />
        <input type="hidden" name="intervalWeeks" value={intervalWeeks} />
        <Button submit size="slim" disabled={busy || atMaxCadence}>
          Slow cadence
        </Button>
      </fetcher.Form>
    </InlineStack>
  );
}

function ThresholdForm({ initial }: { initial: number }) {
  const fetcher = useFetcher<typeof action>();
  const [value, setValue] = useState(String(initial));
  return (
    <fetcher.Form method="post">
      <BlockStack gap="300">
        <input type="hidden" name="intent" value="saveChurnThreshold" />
        <TextField
          label="Churn alert threshold (0–1)"
          name="churnThreshold"
          type="number"
          value={value}
          onChange={setValue}
          autoComplete="off"
          step={0.05}
          min={0.05}
          max={0.95}
          helpText="Contracts scoring at or above this value trigger HIGH_CHURN_RISK outreach. The subscribers list's HIGH band follows the same value."
        />
        <InlineStack gap="200">
          <Button submit variant="primary" loading={fetcher.state !== "idle"}>
            Save
          </Button>
          {fetcher.data ? (
            <Text
              as="span"
              tone={fetcher.data.ok ? "success" : "critical"}
              variant="bodySm"
            >
              {fetcher.data.message}
            </Text>
          ) : null}
        </InlineStack>
      </BlockStack>
    </fetcher.Form>
  );
}

export default function RetentionPage() {
  const {
    reasonRows,
    summary,
    churnRows,
    scoredCount,
    churnThreshold,
    mediumFloor,
    maxIntervalWeeks,
    modelHealth,
  } = useLoaderData<typeof loader>();

  const reasonTableRows = reasonRows.map((r) => [
    r.reason,
    r.started,
    r.saved,
    r.cancelled,
    r.abandoned,
    r.saveRate,
  ]);

  const churnTableRows = churnRows.map((c) => [
    c.email,
    <InlineStack key={`${c.contractId}-score`} gap="100" wrap={false}>
      <Badge tone={riskTone(c.score, churnThreshold)}>
        {`${Math.round(c.score * 100)}%`}
      </Badge>
      {c.status === "PAUSED" ? (
        <Badge tone={c.pauseOverdue ? "critical" : "info"}>
          {c.pauseOverdue ? "Pause overdue" : "Paused"}
        </Badge>
      ) : null}
    </InlineStack>,
    c.topFactors.length > 0 ? c.topFactors.join(", ") : "—",
    c.nextBillingDate,
    <ChurnActions
      key={`${c.contractId}-actions`}
      contractId={c.contractId}
      intervalWeeks={c.intervalWeeks}
      atMaxCadence={c.atMaxCadence}
    />,
  ]);

  return (
    <Page
      title="Retention"
      subtitle="Cancellation flow performance, churn risk and the save-offer playbook"
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Cancellation flow
              </Text>
              <InlineStack gap="600">
                <Text as="p" variant="bodyMd">
                  Sessions: <b>{summary.totalSessions}</b>
                </Text>
                <Text as="p" variant="bodyMd">
                  Save rate:{" "}
                  <b>
                    {summary.overallSaveRate == null
                      ? "—"
                      : `${summary.overallSaveRate}%`}
                  </b>
                </Text>
                <Text as="p" variant="bodyMd">
                  Avg. save cost: <b>{summary.avgSaveCost}</b>
                </Text>
              </InlineStack>
              {reasonTableRows.length > 0 ? (
                <DataTable
                  columnContentTypes={[
                    "text",
                    "numeric",
                    "numeric",
                    "numeric",
                    "numeric",
                    "text",
                  ]}
                  headings={[
                    "Reason",
                    "Started",
                    "Saved",
                    "Cancelled",
                    "Abandoned",
                    "Save rate",
                  ]}
                  rows={reasonTableRows}
                />
              ) : (
                <Text as="p" tone="subdued">
                  No cancellation sessions yet.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Churn risk — most at risk
              </Text>
              <Text as="p" tone="subdued">
                Contracts scoring at least {Math.round(mediumFloor * 100)}%
                (including paused plans). Proactive actions execute immediately
                through the contract engine and are audited.
              </Text>
              {churnTableRows.length > 0 ? (
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text"]}
                  headings={[
                    "Customer",
                    "Risk",
                    "Top factors",
                    "Next billing",
                    "Proactive action",
                  ]}
                  rows={churnTableRows}
                />
              ) : scoredCount > 0 ? (
                <Text as="p" tone="subdued">
                  No plans currently at risk — all {scoredCount} scored
                  contracts sit below the attention floor.
                </Text>
              ) : (
                <Text as="p" tone="subdued">
                  No scored contracts yet — the churn scan job populates this
                  list.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Model health
              </Text>
              <Text as="p" variant="bodyMd">
                {modelHealth.status}
              </Text>
              {modelHealth.calibrationRows.length > 0 ? (
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Churn calibration (predicted vs observed)
                  </Text>
                  <DataTable
                    columnContentTypes={[
                      "text",
                      "text",
                      "text",
                      "text",
                      "numeric",
                    ]}
                    headings={["Score band", "Predicted", "Observed", "Calibrated", "n"]}
                    rows={modelHealth.calibrationRows.map((r) => [
                      r.range,
                      r.predicted,
                      r.observed,
                      r.calibrated,
                      r.n,
                    ])}
                  />
                </BlockStack>
              ) : null}
              {modelHealth.brierTrend.length > 0 ? (
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Accuracy trend (Brier score — lower is better)
                  </Text>
                  <DataTable
                    columnContentTypes={["numeric", "text", "text", "numeric"]}
                    headings={["Version", "Computed", "Brier", "Outcomes"]}
                    rows={modelHealth.brierTrend.map((r) => [
                      r.version,
                      r.computedAt,
                      r.brier,
                      r.n,
                    ])}
                  />
                </BlockStack>
              ) : null}
              {modelHealth.learnedOffsets.length > 0 ? (
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Learned dunning retry offsets (days after failure)
                  </Text>
                  <DataTable
                    columnContentTypes={["text", "text"]}
                    headings={["Decline category", "Best offsets"]}
                    rows={modelHealth.learnedOffsets.map((r) => [
                      r.category,
                      r.offsets,
                    ])}
                  />
                  <Text as="p" tone="subdued" variant="bodySm">
                    Merchant overrides on the Payment recovery page always win
                    over learned offsets; learned offsets win over the static
                    launch strategy.
                  </Text>
                </BlockStack>
              ) : (
                <Text as="p" tone="subdued" variant="bodySm">
                  Dunning offsets: not enough recovery history yet — the static
                  launch strategies apply
                  {modelHealth.dunningSampleSize > 0
                    ? ` (${modelHealth.dunningSampleSize} episodes observed so far).`
                    : "."}
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Churn alert threshold
              </Text>
              <ThresholdForm initial={churnThreshold} />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Pause design
              </Text>
              <Text as="p" variant="bodyMd">
                Customers can pause for {PAUSE_OPTIONS_DAYS.join(" / ")} days or
                pick an exact resume date. Pauses are never indefinite — every
                pause carries a resume date, a PAUSE_ENDING reminder goes out
                before deliveries restart, and the pause-resume job reactivates
                the plan on the resume date. Cadence changes are capped at
                every {maxIntervalWeeks} weeks.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Save-offer hierarchy
              </Text>
              <Text as="p" tone="subdued">
                Offers are always presented cheapest-first and capped by the
                profit-aware ceiling: max save cost = P(retain) × expected
                future contribution.
              </Text>
              <List type="number">
                {SAVE_OFFER_TYPES.map((t) => (
                  <List.Item key={t}>
                    <b>{t}</b> — {OFFER_TYPE_NOTES[t]}
                  </List.Item>
                ))}
              </List>
              <Box>
                <Text as="p" tone="subdued" variant="bodySm">
                  Reason rules: TOO_MUCH_PRODUCT and IRRITATION never see a
                  discount; TOO_EXPENSIVE sees a discount only after every
                  structural option; NOT_SEEING_IMPROVEMENT gets education and
                  support first.
                </Text>
              </Box>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
