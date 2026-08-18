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

interface OfferKindStat {
  kind: string;
  shown: number;
  accepted: number;
  acceptPct: number;
}

interface FunnelStats {
  windowDays: number;
  starts: number;
  saved: number;
  /** Concierge saves awaiting the merchant's reply (SAVED_PENDING, v1.28.0). */
  pending: number;
  /** Locked contracts that scheduled their cancellation (CANCEL_SCHEDULED). */
  scheduled: number;
  cancelled: number;
  abandoned: number;
  saveRatePct: number | null;
  reasonBreakdown: ReasonStat[];
  saveRateByReason: SaveRateStat[];
  saveRateByOffer: OfferKindStat[];
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
  reasonOfferCooldownDays: number;
  maxSavesShown: number;
  frequencySuggestDeltaWeeks: number;
  pauseSuggestMonths: number;
  sessionFreshMinutes: number;
  giftSaveEnabled: boolean;
  giftSaveCooldownDays: number;
  downsizeSaveEnabled: boolean;
  delaySaveEnabled: boolean;
  delaySaveMaxDays: number;
  conciergeHoldDays: number;
  conciergeHoldMinLeadHours: number;
  scheduledCancelEnabled: boolean;
  scheduledCancelNoticeDays: number;
  keepLinkTtlDays: number;
  intentFollowupEnabled: boolean;
  intentFollowupHours: number;
  intentFollowupChargeBufferHours: number;
  intentFollowupCooldownDays: number;
  intentBannerDays: number;
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

/** Human labels for the REAL reason vocabulary (cancel/config.server.ts). */
function humanReason(reason: string): string {
  const known: Record<string, string> = {
    TOO_MUCH_PRODUCT: "Too much product",
    TOO_EXPENSIVE: "Too expensive",
    NOT_SEEING_RESULTS: "Not seeing results",
    TRYING_SOMETHING_ELSE: "Trying something else",
    SHIPPING_ISSUES: "Shipping issues",
    PAYMENT_FAILED: "Payment failed (dunning)",
    OTHER: "Other",
  };
  if (known[reason]) return known[reason];
  const words = reason.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Defensive parse of CancelSession.savesShown. The engine persists SaveOffer
 * objects keyed `kind` — read that first; the legacy keys remain as fallbacks
 * for any historical rows.
 */
function offersShown(savesShown: unknown): string[] {
  if (!Array.isArray(savesShown)) return [];
  const out: string[] = [];
  for (const entry of savesShown) {
    if (typeof entry === "string") {
      out.push(entry);
    } else if (entry && typeof entry === "object") {
      const rec = entry as Record<string, unknown>;
      const type = rec.kind ?? rec.type ?? rec.save ?? rec.offer;
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
  let pending = 0;
  let scheduled = 0;
  let cancelled = 0;
  let abandoned = 0;
  let finalOfferShown = 0;
  let finalOfferAccepted = 0;
  let retentionKnown = 0;
  let retentionRetained = 0;
  const byReason = new Map<string, { sessions: number; saved: number }>();
  const byOffer = new Map<string, { shown: number; accepted: number }>();

  for (const session of sessions) {
    if (session.outcome === "SAVED") saved += 1;
    else if (session.outcome === "SAVED_PENDING") pending += 1;
    else if (session.outcome === "CANCEL_SCHEDULED") scheduled += 1;
    else if (session.outcome === "CANCELLED") cancelled += 1;
    else abandoned += 1;

    if (session.reason) {
      const entry = byReason.get(session.reason) ?? { sessions: 0, saved: 0 };
      entry.sessions += 1;
      if (session.outcome === "SAVED") entry.saved += 1;
      byReason.set(session.reason, entry);
    }

    const offers = offersShown(session.savesShown);
    for (const kind of new Set(offers)) {
      const entry = byOffer.get(kind) ?? { shown: 0, accepted: 0 };
      entry.shown += 1;
      byOffer.set(kind, entry);
    }
    if (session.saveAccepted) {
      const entry = byOffer.get(session.saveAccepted) ?? {
        shown: 0,
        accepted: 0,
      };
      entry.accepted += 1;
      byOffer.set(session.saveAccepted, entry);
    }

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

  const saveRateByOffer: OfferKindStat[] = [...byOffer.entries()]
    .map(([kind, v]) => ({
      kind,
      shown: v.shown,
      accepted: v.accepted,
      acceptPct: v.shown > 0 ? round1((v.accepted / v.shown) * 100) : 0,
    }))
    .sort((a, b) => b.shown - a.shown);

  const stats: FunnelStats = {
    windowDays: FUNNEL_WINDOW_DAYS,
    starts,
    saved,
    pending,
    scheduled,
    cancelled,
    abandoned,
    saveRatePct: starts > 0 ? round1((saved / starts) * 100) : null,
    reasonBreakdown,
    saveRateByReason,
    saveRateByOffer,
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
    // Spread the stored value first: fields this form doesn't render (and
    // any future additions) must carry through the wholesale setSetting
    // write instead of being silently reset to their zod defaults.
    const previous = await getSetting(shop.id, "cancelFlow");
    const candidate = {
      ...previous,
      enabled: formData.get("enabled") === "true",
      finalOfferPct: intField("finalOfferPct"),
      finalOfferCycles: intField("finalOfferCycles"),
      finalOfferCooldownDays: intField("finalOfferCooldownDays"),
      reasonOfferPctDefault: intField("reasonOfferPctDefault"),
      reasonOfferCyclesDefault: intField("reasonOfferCyclesDefault"),
      reasonOfferCooldownDays: intField("reasonOfferCooldownDays"),
      maxSavesShown: intField("maxSavesShown"),
      frequencySuggestDeltaWeeks: intField("frequencySuggestDeltaWeeks"),
      pauseSuggestMonths: intField("pauseSuggestMonths"),
      sessionFreshMinutes: intField("sessionFreshMinutes"),
      giftSaveEnabled: formData.get("giftSaveEnabled") === "true",
      giftSaveCooldownDays: intField("giftSaveCooldownDays"),
      downsizeSaveEnabled: formData.get("downsizeSaveEnabled") === "true",
      delaySaveEnabled: formData.get("delaySaveEnabled") === "true",
      delaySaveMaxDays: intField("delaySaveMaxDays"),
      conciergeHoldDays: intField("conciergeHoldDays"),
      conciergeHoldMinLeadHours: intField("conciergeHoldMinLeadHours"),
      scheduledCancelEnabled: formData.get("scheduledCancelEnabled") === "true",
      scheduledCancelNoticeDays: intField("scheduledCancelNoticeDays"),
      keepLinkTtlDays: intField("keepLinkTtlDays"),
      intentFollowupEnabled: formData.get("intentFollowupEnabled") === "true",
      intentFollowupHours: intField("intentFollowupHours"),
      intentFollowupChargeBufferHours: intField("intentFollowupChargeBufferHours"),
      intentFollowupCooldownDays: intField("intentFollowupCooldownDays"),
      intentBannerDays: intField("intentBannerDays"),
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
  // Mirrors REASONS in app/lib/cancel/config.server.ts exactly — a preview
  // that contradicts the live mapping tunes the merchant blind.
  {
    reason: "Too much product",
    saves: "Skip next order → downsize (fewer units / smaller size / cheaper product) → slow down frequency → pause",
    rationale:
      "Cadence mismatch, not dissatisfaction — costs nothing to fix, no discount needed. Downsize keeps every delivery at a lower ARPU instead of zero.",
  },
  {
    reason: "Too expensive",
    saves: "Downsize (fewer units / smaller size / cheaper product, each with its new total) → pause → reason-offer discount (N cycles)",
    rationale:
      "A cheaper configuration answers the price objection without repricing anything; the pause reframes the spend; the small temporary discount stays the fallback, not the lead.",
  },
  {
    reason: "Not seeing results",
    saves: "Routine education / free consultation → swap to another product",
    rationale:
      "Skincare results take 8–12 weeks — education saves without margin cost.",
  },
  {
    reason: "Trying something else",
    saves: "Pause → swap to another product",
    rationale:
      "A pause keeps the relationship open while they experiment; a swap keeps them in the catalog.",
  },
  {
    reason: "Shipping issues",
    saves: "Contact support → slow down frequency",
    rationale:
      "A human fixes the logistics; fewer shipments reduce the friction meanwhile.",
  },
  {
    reason: "Other / no reason",
    saves: "Pause only",
    rationale: "Low-information cancels get the zero-cost save only.",
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
  const [reasonCooldown, setReasonCooldown] = useState(
    String(initial.reasonOfferCooldownDays),
  );
  const [maxSaves, setMaxSaves] = useState(String(initial.maxSavesShown));
  const [freqDelta, setFreqDelta] = useState(
    String(initial.frequencySuggestDeltaWeeks),
  );
  const [pauseMonths, setPauseMonths] = useState(
    String(initial.pauseSuggestMonths),
  );
  const [sessionFresh, setSessionFresh] = useState(
    String(initial.sessionFreshMinutes),
  );
  const [giftSaveEnabled, setGiftSaveEnabled] = useState(
    initial.giftSaveEnabled,
  );
  const [giftSaveCooldown, setGiftSaveCooldown] = useState(
    String(initial.giftSaveCooldownDays),
  );
  const [downsizeSaveEnabled, setDownsizeSaveEnabled] = useState(
    initial.downsizeSaveEnabled ?? true,
  );
  const [delaySaveEnabled, setDelaySaveEnabled] = useState(
    initial.delaySaveEnabled ?? true,
  );
  const [delaySaveMaxDays, setDelaySaveMaxDays] = useState(
    String(initial.delaySaveMaxDays ?? 42),
  );
  const [conciergeHoldDays, setConciergeHoldDays] = useState(
    String(initial.conciergeHoldDays ?? 7),
  );
  const [conciergeHoldMinLeadHours, setConciergeHoldMinLeadHours] = useState(
    String(initial.conciergeHoldMinLeadHours ?? 48),
  );
  const [scheduledCancelEnabled, setScheduledCancelEnabled] = useState(
    initial.scheduledCancelEnabled ?? true,
  );
  const [scheduledCancelNoticeDays, setScheduledCancelNoticeDays] = useState(
    String(initial.scheduledCancelNoticeDays ?? 3),
  );
  const [keepLinkTtlDays, setKeepLinkTtlDays] = useState(
    String(initial.keepLinkTtlDays ?? 60),
  );
  const [intentFollowupEnabled, setIntentFollowupEnabled] = useState(
    initial.intentFollowupEnabled ?? true,
  );
  const [intentFollowupHours, setIntentFollowupHours] = useState(
    String(initial.intentFollowupHours ?? 18),
  );
  const [intentFollowupChargeBufferHours, setIntentFollowupChargeBufferHours] =
    useState(String(initial.intentFollowupChargeBufferHours ?? 48));
  const [intentFollowupCooldownDays, setIntentFollowupCooldownDays] = useState(
    String(initial.intentFollowupCooldownDays ?? 30),
  );
  const [intentBannerDays, setIntentBannerDays] = useState(
    String(initial.intentBannerDays ?? 14),
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
        reasonOfferCooldownDays: reasonCooldown,
        maxSavesShown: maxSaves,
        frequencySuggestDeltaWeeks: freqDelta,
        pauseSuggestMonths: pauseMonths,
        sessionFreshMinutes: sessionFresh,
        giftSaveEnabled: String(giftSaveEnabled),
        giftSaveCooldownDays: giftSaveCooldown,
        downsizeSaveEnabled: String(downsizeSaveEnabled),
        delaySaveEnabled: String(delaySaveEnabled),
        delaySaveMaxDays,
        conciergeHoldDays,
        conciergeHoldMinLeadHours,
        scheduledCancelEnabled: String(scheduledCancelEnabled),
        scheduledCancelNoticeDays,
        keepLinkTtlDays,
        intentFollowupEnabled: String(intentFollowupEnabled),
        intentFollowupHours,
        intentFollowupChargeBufferHours,
        intentFollowupCooldownDays,
        intentBannerDays,
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
                  <Box minWidth="200px">
                    <TextField
                      label="Reason-offer cooldown (days)"
                      autoComplete="off"
                      type="number"
                      min={0}
                      max={720}
                      value={reasonCooldown}
                      onChange={setReasonCooldown}
                      error={errors.reasonOfferCooldownDays}
                      helpText="The step-3 discount can only be taken once per this many days — re-walking the flow every couple of cycles must not farm a permanent discount. 0 disables the cooldown."
                    />
                  </Box>
                </InlineStack>
                <Divider />
                <Text as="h3" variant="headingSm">
                  Gift save
                </Text>
                <InlineStack gap="400" wrap blockAlign="start">
                  <Checkbox
                    label="Offer a free product as a save"
                    checked={giftSaveEnabled}
                    onChange={setGiftSaveEnabled}
                    helpText="A dynamically picked product from the gift pool (Gifts page) — costs COGS instead of face-value margin, for non-price cancel reasons."
                  />
                  <Box minWidth="200px">
                    <TextField
                      label="Gift-save cooldown (days)"
                      autoComplete="off"
                      type="number"
                      min={0}
                      max={720}
                      value={giftSaveCooldown}
                      onChange={setGiftSaveCooldown}
                      error={errors.giftSaveCooldownDays}
                      helpText="Per customer, across all their contracts — cancelling and re-subscribing must not farm free products."
                    />
                  </Box>
                </InlineStack>
                <Divider />
                <Text as="h3" variant="headingSm">
                  Downsize save
                </Text>
                <Checkbox
                  label="Offer a cheaper configuration as a save"
                  checked={downsizeSaveEnabled}
                  onChange={setDownsizeSaveEnabled}
                  helpText='For "too expensive" (before the discount) and "too much product" (after skip): fewer units, a smaller size of the same product, or a cheaper product from the same catalog group — each shown with its concrete new per-order total, priced exactly as the swap/quantity change will apply it. Only renders when a genuinely cheaper option exists; counts toward the max cards below.'
                />
                <Divider />
                <Text as="h3" variant="headingSm">
                  Delay save
                </Text>
                <InlineStack gap="400" wrap blockAlign="start">
                  <Checkbox
                    label="Offer “push my next order to when you'll run out”"
                    checked={delaySaveEnabled}
                    onChange={setDelaySaveEnabled}
                    helpText='For "too much product", before the skip: when the churn model predicts the run-out day and it lies after the next charge, the card moves the next order to that day (using your portal delay semantics — whole schedule or this order only). Only renders when the prediction exists and is within the maximum below.'
                  />
                  <Box minWidth="200px">
                    <TextField
                      label="Maximum delay (days)"
                      autoComplete="off"
                      type="number"
                      min={1}
                      max={180}
                      value={delaySaveMaxDays}
                      onChange={setDelaySaveMaxDays}
                      error={errors.delaySaveMaxDays}
                      helpText="Predicted run-out days further out than this fall back to the skip card."
                    />
                  </Box>
                </InlineStack>
                <Divider />
                <Text as="h3" variant="headingSm">
                  Concierge save
                </Text>
                <InlineStack gap="400" wrap>
                  <Box minWidth="200px">
                    <TextField
                      label="Hold the next order (days)"
                      autoComplete="off"
                      type="number"
                      min={0}
                      max={30}
                      value={conciergeHoldDays}
                      onChange={setConciergeHoldDays}
                      error={errors.conciergeHoldDays}
                      helpText='When a customer sends the "talk to a human" request from the cancel flow, their next order is pushed back this many days so nothing charges while you answer (only when the charge is further away than the lead time on the right). 0 = never hold. The card promises the reply within Support → SLA business days; an unanswered request raises a critical alert after that. The session counts as "pending" until you resolve the request alert.'
                    />
                  </Box>
                  <Box minWidth="200px">
                    <TextField
                      label="Only when the charge is more than (hours) away"
                      autoComplete="off"
                      type="number"
                      min={1}
                      max={240}
                      value={conciergeHoldMinLeadHours}
                      onChange={setConciergeHoldMinLeadHours}
                      error={errors.conciergeHoldMinLeadHours}
                      helpText="A hold inside your order cut-off would edit a cycle already being prepared, so the request is recorded without moving the order. Match this to the edit cut-off you communicate to customers."
                    />
                  </Box>
                </InlineStack>
                <Divider />
                <Text as="h3" variant="headingSm">
                  Scheduled cancel (commitment periods)
                </Text>
                <InlineStack gap="400" wrap blockAlign="start">
                  <Checkbox
                    label="Let locked subscribers schedule their cancellation"
                    checked={scheduledCancelEnabled}
                    onChange={setScheduledCancelEnabled}
                    helpText="Inside a plan's commitment period (Plans → lock days) the flow offers “schedule my cancellation for {unlock date}” instead of turning the customer away; the subscription runs as agreed until then and ends automatically that day (never billed after it). Off = the customer is redirected with the unlock date, as before."
                  />
                  <Box minWidth="200px">
                    <TextField
                      label="Reminder before the scheduled cancel (days)"
                      autoComplete="off"
                      type="number"
                      min={1}
                      max={14}
                      value={scheduledCancelNoticeDays}
                      onChange={setScheduledCancelNoticeDays}
                      error={errors.scheduledCancelNoticeDays}
                      helpText="The “your subscription ends on {date}” email with the one-tap keep link goes out this many days before."
                    />
                  </Box>
                  <Box minWidth="200px">
                    <TextField
                      label="Keep link valid for (days)"
                      autoComplete="off"
                      type="number"
                      min={1}
                      max={365}
                      value={keepLinkTtlDays}
                      onChange={setKeepLinkTtlDays}
                      error={errors.keepLinkTtlDays}
                      helpText="How long the one-tap “keep my subscription” link in the scheduled-cancel emails works. Must outlive your longest plan commitment period, or the link in the first email expires before the cancel date."
                    />
                  </Box>
                </InlineStack>
                <Divider />
                <Text as="h3" variant="headingSm">
                  Abandoned cancel intent
                </Text>
                <Checkbox
                  label="Follow up when a customer starts cancelling but leaves without deciding"
                  checked={intentFollowupEnabled}
                  onChange={setIntentFollowupEnabled}
                  helpText="One email (“Cancel intent follow-up” in Emails) with the one-tap saves that match the reason they picked — skip, push back, slower cadence, smaller order or pause — plus a plain link to finish cancelling. Never sent once they saved, cancelled, scheduled a cancel or opened a newer session, and only when at least one save genuinely applies. The portal home shows the same choices as a banner for the days below."
                />
                <InlineStack gap="400" wrap>
                  <Box minWidth="160px">
                    <TextField
                      label="Send after (hours)"
                      autoComplete="off"
                      type="number"
                      min={1}
                      max={72}
                      value={intentFollowupHours}
                      onChange={setIntentFollowupHours}
                      error={errors.intentFollowupHours}
                      helpText="Hours after the abandoned session closes."
                    />
                  </Box>
                  <Box minWidth="160px">
                    <TextField
                      label="Not within (hours) of the next charge"
                      autoComplete="off"
                      type="number"
                      min={0}
                      max={240}
                      value={intentFollowupChargeBufferHours}
                      onChange={setIntentFollowupChargeBufferHours}
                      error={errors.intentFollowupChargeBufferHours}
                      helpText="Skipped when the next charge is closer than this."
                    />
                  </Box>
                  <Box minWidth="160px">
                    <TextField
                      label="Per-customer cooldown (days)"
                      autoComplete="off"
                      type="number"
                      min={0}
                      max={365}
                      value={intentFollowupCooldownDays}
                      onChange={setIntentFollowupCooldownDays}
                      error={errors.intentFollowupCooldownDays}
                      helpText="At most one follow-up email per customer in this window."
                    />
                  </Box>
                  <Box minWidth="160px">
                    <TextField
                      label="Portal banner (days)"
                      autoComplete="off"
                      type="number"
                      min={0}
                      max={60}
                      value={intentBannerDays}
                      onChange={setIntentBannerDays}
                      error={errors.intentBannerDays}
                      helpText="How long the home banner with the same choices stays. 0 = no banner."
                    />
                  </Box>
                </InlineStack>
                <Divider />
                <Text as="h3" variant="headingSm">
                  Flow behavior
                </Text>
                <InlineStack gap="400" wrap>
                  <Box minWidth="160px">
                    <TextField
                      label="Max save cards shown"
                      autoComplete="off"
                      type="number"
                      min={1}
                      max={4}
                      value={maxSaves}
                      onChange={setMaxSaves}
                      error={errors.maxSavesShown}
                      helpText='Step-3 cards per reason. At the default of 2, a "too expensive" customer with a downsize option sees downsize + pause (the discount then only appears when no cheaper configuration exists).'
                    />
                  </Box>
                  <Box minWidth="160px">
                    <TextField
                      label="Frequency suggestion (+weeks equivalent)"
                      autoComplete="off"
                      type="number"
                      min={1}
                      max={12}
                      value={freqDelta}
                      onChange={setFreqDelta}
                      error={errors.frequencySuggestDeltaWeeks}
                      helpText="How much slower the FREQUENCY save suggests. Weekly cadences add this many weeks; day cadences add ×7 days, month cadences ≈ this ÷ 4 months (min 1)."
                    />
                  </Box>
                  <Box minWidth="160px">
                    <TextField
                      label="Pause suggestion (months)"
                      autoComplete="off"
                      type="number"
                      min={1}
                      max={6}
                      value={pauseMonths}
                      onChange={setPauseMonths}
                      error={errors.pauseSuggestMonths}
                      helpText="Clamped by the pause setting's max."
                    />
                  </Box>
                  <Box minWidth="160px">
                    <TextField
                      label="Session freshness (minutes)"
                      autoComplete="off"
                      type="number"
                      min={15}
                      max={720}
                      value={sessionFresh}
                      onChange={setSessionFresh}
                      error={errors.sessionFreshMinutes}
                      helpText="An untouched flow older than this restarts fresh."
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
                  <StatBox label="Pending (concierge)" value={String(stats.pending)} />
                  <StatBox label="Cancel scheduled" value={String(stats.scheduled)} />
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
                  Save rate by offer kind
                </Text>
                {stats.saveRateByOffer.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No offers shown in this window.
                  </Text>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "numeric", "numeric", "text"]}
                    headings={["Offer", "Shown", "Accepted", "Accept rate"]}
                    rows={stats.saveRateByOffer.map((row) => [
                      row.kind,
                      String(row.shown),
                      String(row.accepted),
                      `${row.acceptPct}%`,
                    ])}
                  />
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
                  {`Declining the saves completes the cancel immediately. The deeper final-chance offer (${finalOfferPct}% for ${finalOfferCycles} cycle(s), max once per ${cooldownDays} days) is strictly opt-in via a "See my final offer" link — it is never auto-inserted before completion.`}
                </Text>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
