/**
 * [retention] Admin — payment recovery: dunning queue, recovery reporting
 * (grouped by episode step, not lifetime attempt number), retry-offset
 * editing (merchant > learned > static precedence), pre-dunning settings and
 * the decline-category strategy reference.
 */
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  DataTable,
  InlineStack,
  Layout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { appendAudit } from "~/services/audit.server";
import { requireRole } from "~/services/core/rbac.server";
import {
  MAX_RETRY_OFFSETS,
  RETRY_OFFSET_MAX_DAYS,
  RETRY_OFFSET_MIN_DAYS,
  parseDunningOverrides,
  strategyFor,
} from "~/services/retention/dunning.server";
import { getLearnedDunningOffsets } from "~/services/analytics/learning.server";
import { DECLINE_CATEGORIES, parseJson } from "~/types/domain";
import type { DunningStep } from "~/types/domain";

// ─────────────────────────────── Loader ───────────────────────────────────

interface HistoryEntry {
  at: string;
  type: string;
  action?: string;
  stepIndex?: number;
}

function formatWhen(d: Date | null): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function stepLabel(cumulativeDays: number, action: string): string {
  const label =
    cumulativeDays > 0 && cumulativeDays < 1
      ? `+${Math.round(cumulativeDays * 24)}h`
      : `Day ${Number.isInteger(cumulativeDays) ? cumulativeDays : cumulativeDays.toFixed(1)}`;
  return `${label} ${action}`;
}

/** Cumulative day offsets of the RETRY steps in a strategy. */
function retryDays(steps: DunningStep[]): number[] {
  let cumulative = 0;
  const out: number[] = [];
  for (const s of steps) {
    cumulative += s.afterDays;
    if (s.action === "RETRY") out.push(cumulative);
  }
  return out;
}

/**
 * Episode step from a dunning retry's idempotency key
 * (`bill:<contractId>:<cycle>:<episode>-<idx>`), or null for attempts we did
 * not schedule (external/auto-billing retries).
 */
function episodeStepFromKey(idempotencyKey: string | null): number | null {
  if (!idempotencyKey || !idempotencyKey.startsWith("bill:")) return null;
  const suffix = idempotencyKey.split(":")[3];
  if (!suffix) return null;
  const idx = Number(suffix.split("-")[1]);
  return Number.isInteger(idx) && idx >= 0 ? idx : null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireRole(session, "OWNER", "ADMIN");
  const shop = session.shop;

  // Queue: every dunning state for this shop, most urgent first.
  const states = await prisma.dunningState.findMany({
    where: { contract: { shop } },
    include: { contract: true },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });

  const queueRows = states.map((s) => {
    const history = parseJson<HistoryEntry[]>(s.historyJson, []);
    const tail = history
      .slice(-3)
      .map(
        (h) =>
          `${h.at.slice(0, 10)} ${h.type === "STEP" ? (h.action ?? "STEP") : h.type}`,
      )
      .join(" · ");
    return {
      id: s.id,
      email: s.contract.customerEmail ?? s.contract.shopifyCustomerId,
      phase: s.phase,
      category: s.declineCategory ?? "—",
      retryCount: s.retryCount,
      nextRetryAt: formatWhen(s.nextRetryAt),
      lastFailureAt: formatWhen(s.lastFailureAt),
      historyTail: tail || "—",
    };
  });

  // Recovery report. Three deliberate choices (each fixed a reporting bug):
  //  - settled outcomes only — PENDING retries created moments ago must not
  //    deflate every denominator until their webhook lands;
  //  - grouped by EPISODE STEP (from the retry's idempotency key), never by
  //    lifetime attemptNumber — a new subscriber's first dunning retry and a
  //    2-year subscriber's first dunning retry belong in the same row;
  //  - the category fallback is a dedicated lookup over exactly the involved
  //    contracts, not whatever page of 100 states the queue happens to show.
  const retryAttempts = await prisma.billingAttempt.findMany({
    where: {
      shop,
      isRetry: true,
      status: { in: ["SUCCESS", "FAILURE", "CHALLENGED"] },
    },
    select: {
      contractId: true,
      status: true,
      declineCategory: true,
      idempotencyKey: true,
    },
  });
  const pendingRetries = await prisma.billingAttempt.count({
    where: { shop, isRetry: true, status: "PENDING" },
  });
  const fallbackStates = await prisma.dunningState.findMany({
    where: {
      contractId: { in: [...new Set(retryAttempts.map((a) => a.contractId))] },
    },
    select: { contractId: true, declineCategory: true },
  });
  const stateCategoryByContract = new Map(
    fallbackStates.map((s) => [s.contractId, s.declineCategory ?? "GENERIC_DECLINE"]),
  );

  const byCategory = new Map<string, { attempts: number; recovered: number }>();
  const byStep = new Map<string, { attempts: number; recovered: number }>();
  for (const a of retryAttempts) {
    const category =
      a.declineCategory ??
      stateCategoryByContract.get(a.contractId) ??
      "UNKNOWN";
    const cat = byCategory.get(category) ?? { attempts: 0, recovered: 0 };
    cat.attempts++;
    if (a.status === "SUCCESS") cat.recovered++;
    byCategory.set(category, cat);

    const stepIdx = episodeStepFromKey(a.idempotencyKey);
    const stepKey = stepIdx == null ? "external" : `step ${stepIdx}`;
    const step = byStep.get(stepKey) ?? { attempts: 0, recovered: 0 };
    step.attempts++;
    if (a.status === "SUCCESS") step.recovered++;
    byStep.set(stepKey, step);
  }

  const recoveryByCategory = [...byCategory.entries()].map(([category, r]) => ({
    category,
    attempts: r.attempts,
    recovered: r.recovered,
    rate: r.attempts > 0 ? `${Math.round((r.recovered / r.attempts) * 100)}%` : "—",
  }));
  const recoveryByStep = [...byStep.entries()]
    .sort((a, b) => {
      // "step N" rows ascending, "external" last.
      const na = a[0] === "external" ? Number.POSITIVE_INFINITY : Number(a[0].slice(5));
      const nb = b[0] === "external" ? Number.POSITIVE_INFINITY : Number(b[0].slice(5));
      return na - nb;
    })
    .map(([step, r]) => ({
      step,
      attempts: r.attempts,
      recovered: r.recovered,
      rate:
        r.attempts > 0 ? `${Math.round((r.recovered / r.attempts) * 100)}%` : "—",
    }));

  // Settings: pre-dunning lead + merchant retry-offset overrides.
  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  const settingsObj = parseJson<Record<string, unknown>>(
    settings?.settingsJson,
    {},
  );
  const rawLead = Number(settingsObj.preDunningLeadDays);
  const preDunningLeadDays =
    Number.isFinite(rawLead) && rawLead > 0 ? rawLead : 10;
  const overrides = parseDunningOverrides(settingsObj.dunningOverrides);

  // Strategy reference (standard subscriber; high-value gets +1 grace step)
  // plus the three offset layers per category for the editor.
  const strategyRows = [] as Array<{
    category: string;
    retries: number;
    sequence: string;
  }>;
  const offsetRows = [] as Array<{
    category: string;
    staticOffsets: string;
    learnedOffsets: string;
    override: string;
    effective: "merchant" | "learned" | "static";
    editable: boolean;
  }>;
  for (const category of DECLINE_CATEGORIES) {
    const steps: DunningStep[] = strategyFor(category, false);
    let cumulative = 0;
    const sequence = steps
      .map((s) => {
        cumulative += s.afterDays;
        return stepLabel(cumulative, s.action);
      })
      .join("  →  ");
    const staticRetryDays = retryDays(steps);
    strategyRows.push({
      category,
      retries: staticRetryDays.length,
      sequence,
    });

    const learned = await getLearnedDunningOffsets(shop, category);
    const merchant = overrides[category] ?? null;
    offsetRows.push({
      category,
      staticOffsets: staticRetryDays.length > 0 ? staticRetryDays.join(", ") : "never retried",
      learnedOffsets: learned && learned.length > 0 ? learned.join(", ") : "—",
      override: merchant ? merchant.join(", ") : "",
      effective: merchant ? "merchant" : learned && learned.length > 0 ? "learned" : "static",
      editable: staticRetryDays.length > 0,
    });
  }

  return json({
    queueRows,
    recoveryByCategory,
    recoveryByStep,
    pendingRetries,
    preDunningLeadDays,
    strategyRows,
    offsetRows,
    offsetBounds: {
      min: RETRY_OFFSET_MIN_DAYS,
      max: RETRY_OFFSET_MAX_DAYS,
      count: MAX_RETRY_OFFSETS,
    },
  });
};

// ─────────────────────────────── Action ───────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireRole(session, "OWNER", "ADMIN");
  const shop = session.shop;

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "saveLeadDays") {
    const leadDays = Number(form.get("leadDays"));
    if (!Number.isFinite(leadDays) || leadDays < 1 || leadDays > 60) {
      return json(
        { ok: false, message: "Lead days must be between 1 and 60." },
        400,
      );
    }

    const settings = await prisma.shopSettings.findUnique({ where: { shop } });
    const settingsObj = parseJson<Record<string, unknown>>(
      settings?.settingsJson,
      {},
    );
    settingsObj.preDunningLeadDays = leadDays;
    await prisma.shopSettings.upsert({
      where: { shop },
      create: { shop, settingsJson: JSON.stringify(settingsObj) },
      update: { settingsJson: JSON.stringify(settingsObj) },
    });

    await appendAudit({
      shop,
      actorType: "STAFF",
      actorId: session.onlineAccessInfo?.associated_user?.email ?? "admin",
      action: "PRE_DUNNING_SETTINGS_UPDATED",
      subjectType: "ShopSettings",
      subjectId: shop,
      payload: { preDunningLeadDays: leadDays },
    });

    return json({ ok: true, message: "Pre-dunning lead time saved." });
  }

  if (intent === "saveDunningOverrides") {
    // Parse each category's comma-separated day list; strict validation —
    // whole days 1..30, at most 4 retries; empty clears the override.
    const overrides: Record<string, number[]> = {};
    for (const category of DECLINE_CATEGORIES) {
      const raw = String(form.get(`override_${category}`) ?? "").trim();
      if (!raw) continue;
      const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
      const days = parts.map((p) => Number(p));
      if (
        parts.length === 0 ||
        parts.length > MAX_RETRY_OFFSETS ||
        days.some(
          (d) =>
            !Number.isInteger(d) ||
            d < RETRY_OFFSET_MIN_DAYS ||
            d > RETRY_OFFSET_MAX_DAYS,
        )
      ) {
        return json(
          {
            ok: false,
            message: `${category}: retry days must be ${MAX_RETRY_OFFSETS} or fewer whole numbers between ${RETRY_OFFSET_MIN_DAYS} and ${RETRY_OFFSET_MAX_DAYS} (e.g. "3, 5, 7").`,
          },
          400,
        );
      }
      overrides[category] = [...new Set(days)].sort((a, b) => a - b);
    }

    const settings = await prisma.shopSettings.findUnique({ where: { shop } });
    const settingsObj = parseJson<Record<string, unknown>>(
      settings?.settingsJson,
      {},
    );
    if (Object.keys(overrides).length > 0) {
      settingsObj.dunningOverrides = overrides;
    } else {
      delete settingsObj.dunningOverrides;
    }
    await prisma.shopSettings.upsert({
      where: { shop },
      create: { shop, settingsJson: JSON.stringify(settingsObj) },
      update: { settingsJson: JSON.stringify(settingsObj) },
    });

    await appendAudit({
      shop,
      actorType: "STAFF",
      actorId: session.onlineAccessInfo?.associated_user?.email ?? "admin",
      action: "DUNNING_OVERRIDES_UPDATED",
      subjectType: "ShopSettings",
      subjectId: shop,
      payload: { dunningOverrides: overrides },
    });

    return json({ ok: true, message: "Retry-day overrides saved." });
  }

  return json({ ok: false, message: "Unknown action" }, 400);
};

// ─────────────────────────────── UI ───────────────────────────────────────

function phaseTone(
  phase: string,
): "success" | "attention" | "warning" | "critical" | "info" | undefined {
  switch (phase) {
    case "RESOLVED":
      return "success";
    case "RETRYING":
      return "attention";
    case "GRACE":
    case "FINAL_NOTICE":
      return "warning";
    case "EXHAUSTED":
      return "critical";
    case "PRE_DUNNING":
      return "info";
    default:
      return undefined;
  }
}

function LeadDaysForm({ initial }: { initial: number }) {
  const fetcher = useFetcher<typeof action>();
  const [value, setValue] = useState(String(initial));
  return (
    <fetcher.Form method="post">
      <BlockStack gap="300">
        <input type="hidden" name="intent" value="saveLeadDays" />
        <TextField
          label="Lead time before next charge (days)"
          name="leadDays"
          type="number"
          value={value}
          onChange={setValue}
          autoComplete="off"
          min={1}
          max={60}
          helpText="Subscribers whose card expires before their next charge plus this lead time get a card-expiry notice and Shopify's secure payment-update email."
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

function OffsetsEditor({
  rows,
  bounds,
}: {
  rows: Array<{
    category: string;
    staticOffsets: string;
    learnedOffsets: string;
    override: string;
    effective: "merchant" | "learned" | "static";
    editable: boolean;
  }>;
  bounds: { min: number; max: number; count: number };
}) {
  const fetcher = useFetcher<typeof action>();
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(rows.map((r) => [r.category, r.override])),
  );
  return (
    <fetcher.Form method="post">
      <BlockStack gap="300">
        <input type="hidden" name="intent" value="saveDunningOverrides" />
        <Text as="p" tone="subdued" variant="bodySm">
          Retry days after the failure, comma-separated (e.g. "3, 5, 7"). Up to{" "}
          {bounds.count} retries, each {bounds.min}–{bounds.max} days. Leave
          blank to fall back to learned offsets, then the static strategy.
          Categories that are never retried by design cannot be overridden.
        </Text>
        {rows.map((r) => (
          <BlockStack key={r.category} gap="100">
            <InlineStack gap="200" blockAlign="center">
              <Text as="span" variant="bodyMd" fontWeight="semibold">
                {r.category}
              </Text>
              <Badge
                tone={
                  r.effective === "merchant"
                    ? "attention"
                    : r.effective === "learned"
                      ? "info"
                      : undefined
                }
              >
                {`using ${r.effective}`}
              </Badge>
            </InlineStack>
            <InlineStack gap="400" blockAlign="center" wrap>
              <Text as="span" tone="subdued" variant="bodySm">
                static: {r.staticOffsets}
              </Text>
              <Text as="span" tone="subdued" variant="bodySm">
                learned: {r.learnedOffsets}
              </Text>
            </InlineStack>
            {r.editable ? (
              <TextField
                label={`${r.category} override`}
                labelHidden
                name={`override_${r.category}`}
                value={values[r.category] ?? ""}
                onChange={(v) =>
                  setValues((prev) => ({ ...prev, [r.category]: v }))
                }
                autoComplete="off"
                placeholder="e.g. 3, 5, 7"
              />
            ) : (
              <input type="hidden" name={`override_${r.category}`} value="" />
            )}
          </BlockStack>
        ))}
        <InlineStack gap="200">
          <Button submit variant="primary" loading={fetcher.state !== "idle"}>
            Save overrides
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

export default function DunningPage() {
  const {
    queueRows,
    recoveryByCategory,
    recoveryByStep,
    pendingRetries,
    preDunningLeadDays,
    strategyRows,
    offsetRows,
    offsetBounds,
  } = useLoaderData<typeof loader>();

  const queueTableRows = queueRows.map((r) => [
    r.email,
    <Badge key={`${r.id}-phase`} tone={phaseTone(r.phase)}>
      {r.phase}
    </Badge>,
    r.category,
    r.retryCount,
    r.nextRetryAt,
    r.lastFailureAt,
    r.historyTail,
  ]);

  return (
    <Page
      title="Payment recovery"
      subtitle="Decline-aware retries, recovery performance and pre-dunning"
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Recovery queue
              </Text>
              {queueTableRows.length > 0 ? (
                <DataTable
                  columnContentTypes={[
                    "text",
                    "text",
                    "text",
                    "numeric",
                    "text",
                    "text",
                    "text",
                  ]}
                  headings={[
                    "Customer",
                    "Phase",
                    "Category",
                    "Retries",
                    "Next action",
                    "Last failure",
                    "Recent history",
                  ]}
                  rows={queueTableRows}
                />
              ) : (
                <Text as="p" tone="subdued">
                  No payment issues in the queue.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Recovery by decline category
              </Text>
              {recoveryByCategory.length > 0 ? (
                <DataTable
                  columnContentTypes={["text", "numeric", "numeric", "text"]}
                  headings={["Category", "Retries", "Recovered", "Rate"]}
                  rows={recoveryByCategory.map((r) => [
                    r.category,
                    r.attempts,
                    r.recovered,
                    r.rate,
                  ])}
                />
              ) : (
                <Text as="p" tone="subdued">
                  No settled retry attempts recorded yet.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Recovery by episode step
              </Text>
              <Text as="p" tone="subdued" variant="bodySm">
                Settled outcomes only
                {pendingRetries > 0
                  ? ` — ${pendingRetries} retr${pendingRetries === 1 ? "y" : "ies"} in flight`
                  : ""}
                . "external" groups retries Shopify initiated outside the
                dunning strategy.
              </Text>
              {recoveryByStep.length > 0 ? (
                <DataTable
                  columnContentTypes={["text", "numeric", "numeric", "text"]}
                  headings={["Episode step", "Retries", "Recovered", "Rate"]}
                  rows={recoveryByStep.map((r) => [
                    r.step,
                    r.attempts,
                    r.recovered,
                    r.rate,
                  ])}
                />
              ) : (
                <Text as="p" tone="subdued">
                  No settled retry attempts recorded yet.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Retry-day overrides
              </Text>
              <OffsetsEditor rows={offsetRows} bounds={offsetBounds} />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Pre-dunning
              </Text>
              <LeadDaysForm initial={preDunningLeadDays} />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Strategy reference
              </Text>
              <Text as="p" tone="subdued">
                Sequences differ per decline category. High-value subscribers
                get one extra grace step before any pause or cancel. Lost or
                stolen cards and permanent failures are never retried. Retry
                timing follows merchant overrides first, then learned offsets,
                then this static table.
              </Text>
              <DataTable
                columnContentTypes={["text", "numeric", "text"]}
                headings={["Category", "Retries", "Sequence"]}
                rows={strategyRows.map((r) => [r.category, r.retries, r.sequence])}
              />
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
