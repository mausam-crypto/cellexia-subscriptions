import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  DataTable,
  Divider,
  InlineStack,
  Layout,
  Page,
  ProgressBar,
  RangeSlider,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { subDays } from "date-fns";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { getSetting, setSetting } from "~/lib/settings/settings.server";
import { settingsSchemas } from "~/lib/settings/registry.server";
import { logEvent } from "~/lib/events/log.server";

/**
 * Admin — Cancel-flow configuration + funnel performance.
 *
 * Edits the `cancelFlow` setting (reason-matched saves, final-chance offer,
 * cooldown) and shows the last-90-day funnel: starts, reasons, save rates,
 * final-offer acceptance and 90-day retention of saved customers. The
 * retention number is the honesty check — a save that churns two cycles later
 * only postponed the cancel and paid a discount for the privilege.
 */

// ── View types ───────────────────────────────────────────────────────────────

interface ReasonStat {
  reason: string;
  count: number;
  pct: number;
}

interface SaveRateStat {
  reason: string;
  sessions: number;
  saved: number;
  ratePct: number;
}

interface FunnelStats {
  windowDays: number;
  starts: number;
  saved: number;
  cancelled: number;
  abandoned: number;
  saveRatePct: number | null;
  reasonBreakdown: ReasonStat[];
  saveRateByReason: SaveRateStat[];
  finalOfferShown: number;
  finalOfferAccepted: number;
  finalOfferAcceptPct: number | null;
  retentionKnown: number;
  retentionRetained: number;
  retentionPct: number | null;
}

interface CancelFlowValues {
  enabled: boolean;
  finalOfferPct: number;
  finalOfferCycles: number;
  finalOfferCooldownDays: number;
  reasonOfferPctDefault: number;
  reasonOfferCyclesDefault: number;
}

interface ActionData {
  intent: string;
  ok: boolean;
  toast?: string;
  errors?: Record<string, string>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function actorFromSession(session: {
  shop: string;
  onlineAccessInfo?: { associated_user?: { email?: string | null } } | null;
}): string {
  return session.onlineAccessInfo?.associated_user?.email ?? `admin@${session.shop}`;
}

function humanReason(reason: string): string {
  const known: Record<string, string> = {
    TOO_MUCH_PRODUCT: "Too much product",
    TOO_EXPENSIVE: "Too expensive",
    NOT_SEEING_RESULTS: "Not seeing results",
    SHIPPING_ISSUES: "Shipping issues",
    PRODUCT_REACTION: "Product didn't suit my skin",
    SWITCHING_PRODUCTS: "Switching products",
    OTHER: "Other",
  };
  if (known[reason]) return known[reason];
  const words = reason.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Defensive parse of CancelSession.savesShown (list of offers presented). */
function offersShown(savesShown: unknown): string[] {
  if (!Array.isArray(savesShown)) return [];
  const out: string[] = [];
  for (const entry of savesShown) {
    if (typeof entry === "string") {
      out.push(entry);
    } else if (entry && typeof entry === "object") {
      const rec = entry as Record<string, unknown>;
      const type = rec.type ?? rec.save ?? rec.offer;
      if (typeof type === "string") out.push(type);
    }
  }
  return out;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// ── Loader ───────────────────────────────────────────────────────────────────

const FUNNEL_WINDOW_DAYS = 90;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }

  const [cancelFlow, sessions] = await Promise.all([
    getSetting(shop.id, "cancelFlow"),
    prisma.cancelSession.findMany({
      where: {
        contract: { shopId: shop.id },
        startedAt: { gte: subDays(new Date(), FUNNEL_WINDOW_DAYS) },
      },
      select: {
        reason: true,
        savesShown: true,
        saveAccepted: true,
        outcome: true,
        retainedAt90d: true,
      },
    }),
  ]);

  const starts = sessions.length;
  let saved = 0;
  let cancelled = 0;
  let abandoned = 0;
  let finalOfferShown = 0;
  let finalOfferAccepted = 0;
  let retentionKnown = 0;
  let retentionRetained = 0;
  const byReason = new Map<string, { sessions: number; saved: number }>();

  for (const session of sessions) {
    if (session.outcome === "SAVED") saved += 1;
    else if (session.outcome === "CANCELLED") cancelled += 1;
    else abandoned += 1;

    if (session.reason) {
      const entry = byReason.get(session.reason) ?? { sessions: 0, saved: 0 };
      entry.sessions += 1;
      if (session.outcome === "SAVED") entry.saved += 1;
      byReason.set(session.reason, entry);
    }

    const offers = offersShown(session.savesShown);
    if (offers.some((o) => o.toUpperCase().includes("FINAL"))) {
      finalOfferShown += 1;
      if (
        session.saveAccepted &&
        session.saveAccepted.toUpperCase().includes("FINAL")
      ) {
        finalOfferAccepted += 1;
      }
    }

    if (session.outcome === "SAVED" && session.retainedAt90d != null) {
      retentionKnown += 1;
      if (session.retainedAt90d) retentionRetained += 1;
    }
  }

  const reasonTotal = [...byReason.values()].reduce(
    (sum, v) => sum + v.sessions,
    0,
  );
  const reasonBreakdown: ReasonStat[] = [...byReason.entries()]
    .map(([reason, v]) => ({
      reason,
      count: v.sessions,
      pct: reasonTotal > 0 ? round1((v.sessions / reasonTotal) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count);
  const saveRateByReason: SaveRateStat[] = [...byReason.entries()]
    .map(([reason, v]) => ({
      reason,
      sessions: v.sessions,
      saved: v.saved,
      ratePct: v.sessions > 0 ? round1((v.saved / v.sessions) * 100) : 0,
    }))
    .sort((a, b) => b.sessions - a.sessions);

  const stats: FunnelStats = {
    windowDays: FUNNEL_WINDOW_DAYS,
    starts,
    saved,
    cancelled,
    abandoned,
    saveRatePct: starts > 0 ? round1((saved / starts) * 100) : null,
    reasonBreakdown,
    saveRateByReason,
    finalOfferShown,
    finalOfferAccepted,
    finalOfferAcceptPct:
      finalOfferShown > 0
        ? round1((finalOfferAccepted / finalOfferShown) * 100)
        : null,
    retentionKnown,
    retentionRetained,
    retentionPct:
      retentionKnown > 0
        ? round1((retentionRetained / retentionKnown) * 100)
        : null,
  };

  return json({ cancelFlow, stats });
};

// ── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }
  const actor = actorFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "save-cancel-flow") {
    const intField = (name: string) => {
      const raw = String(formData.get(name) ?? "").trim();
      return raw === "" ? Number.NaN : Number(raw);
    };
    const candidate = {
      enabled: formData.get("enabled") === "true",
      finalOfferPct: intField("finalOfferPct"),
      finalOfferCycles: intField("finalOfferCycles"),
      finalOfferCooldownDays: intField("finalOfferCooldownDays"),
      reasonOfferPctDefault: intField("reasonOfferPctDefault"),
      reasonOfferCyclesDefault: intField("reasonOfferCyclesDefault"),
    };
    const parsed = settingsSchemas.cancelFlow.safeParse(candidate);
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "form");
        if (!errors[key]) errors[key] = issue.message;
      }
      return json<ActionData>({ intent, ok: false, errors }, { status: 422 });
    }

    await setSetting(shop.id, "cancelFlow", parsed.data, actor);
    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "ADMIN",
      actor,
      payload: {
        action: "settings_updated",
        key: "cancelFlow",
        value: parsed.data,
      },
    });
    return json<ActionData>({
      intent,
      ok: true,
      toast: "Cancel-flow settings saved",
    });
  }

  return json<ActionData>(
    { intent, ok: false, toast: "Unknown action" },
    { status: 400 },
  );
};

// ── Reason → saves mapping preview (read-only) ───────────────────────────────
//
// The authoritative mapping lives in the cancel-flow module (app/lib/cancel/);
// this table documents the default behaviour so the merchant can see what a
// customer giving each reason is offered, in order.

const REASON_SAVES_PREVIEW: Array<{
  reason: string;
  saves: string;
  rationale: string;
}> = [
  {
    reason: "Too much product",
    saves: "Skip next order → slow down frequency",
    rationale:
      "Cadence mismatch, not dissatisfaction — costs nothing to fix, no discount needed.",
  },
  {
    reason: "Too expensive",
    saves: "Reason-offer discount (N cycles) → slow down frequency",
    rationale:
      "A small, temporary discount beats losing the whole lifetime margin.",
  },
  {
    reason: "Not seeing results",
    saves: "Routine education / usage tips → swap to another product",
    rationale:
      "Skincare results take 8–12 weeks — education saves without margin cost.",
  },
  {
    reason: "Shipping issues",
    saves: "Pause 1–3 months → adjust next date",
    rationale: "A pause keeps the relationship while the logistics get fixed.",
  },
  {
    reason: "Other / no reason",
    saves: "Pause → skip next order",
    rationale: "Low-information cancels get the zero-cost saves only.",
  },
];

// ── Page ─────────────────────────────────────────────────────────────────────

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <Box
      borderColor="border"
      borderWidth="025"
      borderRadius="200"
      padding="300"
      minWidth="140px"
    >
      <BlockStack gap="050">
        <Text as="p" tone="subdued" variant="bodySm">
          {label}
        </Text>
        <Text as="p" variant="headingLg">
          {value}
        </Text>
      </BlockStack>
    </Box>
  );
}

export default function CancelFlowPage() {
  const { cancelFlow, stats } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const navigation = useNavigation();

  const initial = cancelFlow as CancelFlowValues;
  const [enabled, setEnabled] = useState(initial.enabled);
  const [finalOfferPct, setFinalOfferPct] = useState(initial.finalOfferPct);
  const [finalOfferCycles, setFinalOfferCycles] = useState(
    String(initial.finalOfferCycles),
  );
  const [cooldownDays, setCooldownDays] = useState(
    String(initial.finalOfferCooldownDays),
  );
  const [reasonPct, setReasonPct] = useState(
    String(initial.reasonOfferPctDefault),
  );
  const [reasonCycles, setReasonCycles] = useState(
    String(initial.reasonOfferCyclesDefault),
  );

  useEffect(() => {
    if (!actionData) return;
    if (actionData.toast) {
      shopify.toast.show(actionData.toast, { isError: !actionData.ok });
    }
  }, [actionData, shopify]);

  const errors =
    actionData && actionData.intent === "save-cancel-flow" && !actionData.ok
      ? (actionData.errors ?? {})
      : {};

  const saving =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "save-cancel-flow";

  const save = () => {
    submit(
      {
        intent: "save-cancel-flow",
        enabled: String(enabled),
        finalOfferPct: String(finalOfferPct),
        finalOfferCycles,
        finalOfferCooldownDays: cooldownDays,
        reasonOfferPctDefault: reasonPct,
        reasonOfferCyclesDefault: reasonCycles,
      },
      { method: "post" },
    );
  };

  const guardrail =
    finalOfferPct === 0
      ? "Final offer disabled — the flow relies on reason-matched saves only."
      : finalOfferPct > 30
        ? "Aggressive: discounts this deep train customers to threaten cancellation. Keep it as a true last resort."
        : "Shown only on the very last step, after every reason-matched save was declined.";

  const cyclesOptions = [1, 2, 3, 4].map((n) => ({
    label: `${n} cycle${n > 1 ? "s" : ""}`,
    value: String(n),
  }));

  const retentionTone: "success" | "warning" | "critical" | "info" =
    stats.retentionPct == null
      ? "info"
      : stats.retentionPct < 20
        ? "critical"
        : "success";

  return (
    <Page
      title="Cancel flow"
      subtitle="Reason survey → reason-matched saves → one final-chance offer. Configured here, served in the portal."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Configuration
                </Text>
                <Checkbox
                  label="Cancel-save flow enabled"
                  checked={enabled}
                  onChange={setEnabled}
                  helpText="When off, cancelling in the portal skips straight to confirmation (still records the reason)."
                />
                <Divider />
                <RangeSlider
                  label={`Final-chance offer: ${finalOfferPct}% off`}
                  value={finalOfferPct}
                  min={0}
                  max={40}
                  step={1}
                  output
                  onChange={(value) =>
                    setFinalOfferPct(Array.isArray(value) ? value[0] : value)
                  }
                  helpText={guardrail}
                />
                {finalOfferPct > 30 ? (
                  <Banner tone="warning">
                    Above 30% the offer usually costs more margin than the
                    churn it prevents — check the 90-day retention number below
                    before going this high.
                  </Banner>
                ) : null}
                {errors.finalOfferPct ? (
                  <Text as="p" tone="critical" variant="bodySm">
                    {errors.finalOfferPct}
                  </Text>
                ) : null}
                <InlineStack gap="400" wrap>
                  <Box minWidth="200px">
                    <Select
                      label="Final offer lasts"
                      options={cyclesOptions}
                      value={finalOfferCycles}
                      onChange={setFinalOfferCycles}
                      error={errors.finalOfferCycles}
                      helpText="Temporary by design — applied per cycle via contract edits, never codes."
                    />
                  </Box>
                  <Box minWidth="200px">
                    <TextField
                      label="Final-offer cooldown (days)"
                      autoComplete="off"
                      type="number"
                      min={30}
                      max={720}
                      value={cooldownDays}
                      onChange={setCooldownDays}
                      error={errors.finalOfferCooldownDays}
                      helpText="A customer can only receive the final offer once per this many days — stops serial discount farming."
                    />
                  </Box>
                </InlineStack>
                <Divider />
                <Text as="h3" variant="headingSm">
                  Reason-matched offer defaults
                </Text>
                <InlineStack gap="400" wrap>
                  <Box minWidth="200px">
                    <TextField
                      label="Reason-offer discount %"
                      autoComplete="off"
                      type="number"
                      min={0}
                      max={30}
                      value={reasonPct}
                      onChange={setReasonPct}
                      suffix="%"
                      error={errors.reasonOfferPctDefault}
                      helpText='Used by money-sensitive reasons ("too expensive") — keep well below the final offer.'
                    />
                  </Box>
                  <Box minWidth="200px">
                    <Select
                      label="Reason-offer lasts"
                      options={cyclesOptions}
                      value={reasonCycles}
                      onChange={setReasonCycles}
                      error={errors.reasonOfferCyclesDefault}
                    />
                  </Box>
                </InlineStack>
                <InlineStack align="end">
                  <Button variant="primary" onClick={save} loading={saving}>
                    Save settings
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  {`Funnel — last ${stats.windowDays} days`}
                </Text>
                <InlineStack gap="300" wrap>
                  <StatBox label="Flow starts" value={String(stats.starts)} />
                  <StatBox
                    label="Saved"
                    value={`${stats.saved}${
                      stats.saveRatePct != null
                        ? ` (${stats.saveRatePct}%)`
                        : ""
                    }`}
                  />
                  <StatBox label="Cancelled" value={String(stats.cancelled)} />
                  <StatBox label="Abandoned" value={String(stats.abandoned)} />
                  <StatBox
                    label="Final offer accepted"
                    value={
                      stats.finalOfferShown > 0
                        ? `${stats.finalOfferAccepted}/${stats.finalOfferShown}${
                            stats.finalOfferAcceptPct != null
                              ? ` (${stats.finalOfferAcceptPct}%)`
                              : ""
                          }`
                        : "—"
                    }
                  />
                </InlineStack>

                <Banner tone={retentionTone}>
                  {stats.retentionPct == null
                    ? "90-day retention of saved customers: no data yet (retention is measured 90 days after each save)."
                    : `90-day retention of saved customers: ${stats.retentionPct}% (${stats.retentionRetained}/${stats.retentionKnown}). Target: 20–30%+ still active — below that, saves are only postponing cancels at a discount.`}
                </Banner>

                <Divider />
                <Text as="h3" variant="headingSm">
                  Cancellation reasons
                </Text>
                {stats.reasonBreakdown.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No reasons recorded in this window.
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {stats.reasonBreakdown.map((row) => (
                      <BlockStack key={row.reason} gap="050">
                        <InlineStack align="space-between">
                          <Text as="span" variant="bodySm">
                            {humanReason(row.reason)}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {`${row.count} (${row.pct}%)`}
                          </Text>
                        </InlineStack>
                        <ProgressBar progress={row.pct} size="small" />
                      </BlockStack>
                    ))}
                  </BlockStack>
                )}

                <Divider />
                <Text as="h3" variant="headingSm">
                  Save rate by reason
                </Text>
                {stats.saveRateByReason.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No completed sessions in this window.
                  </Text>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "numeric", "numeric", "text"]}
                    headings={["Reason", "Sessions", "Saved", "Save rate"]}
                    rows={stats.saveRateByReason.map((row) => [
                      humanReason(row.reason),
                      String(row.sessions),
                      String(row.saved),
                      <Badge
                        key={row.reason}
                        tone={
                          row.ratePct >= 30
                            ? "success"
                            : row.ratePct >= 15
                              ? "attention"
                              : "critical"
                        }
                      >
                        {`${row.ratePct}%`}
                      </Badge>,
                    ])}
                  />
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Reason → saves mapping (read-only)
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    Each reason gets saves that address the actual problem,
                    cheapest first; the discounted final offer only ever appears
                    as the last step, at most once per cooldown. The live
                    mapping is implemented in the cancel-flow module — this
                    preview documents the default behaviour.
                  </Text>
                </BlockStack>
                <DataTable
                  columnContentTypes={["text", "text", "text"]}
                  headings={["Reason", "Saves offered (in order)", "Why"]}
                  rows={REASON_SAVES_PREVIEW.map((row) => [
                    row.reason,
                    row.saves,
                    row.rationale,
                  ])}
                />
                <Text as="p" tone="subdued" variant="bodySm">
                  {`After all reason-matched saves are declined: final-chance offer (${finalOfferPct}% for ${finalOfferCycles} cycle(s), max once per ${cooldownDays} days), then the cancel completes with one click.`}
                </Text>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
