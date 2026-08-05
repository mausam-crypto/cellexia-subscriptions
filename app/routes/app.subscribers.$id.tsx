/**
 * [subscribers] — the customer-service console for one treatment plan.
 *
 * Full contract view (customer, lines, cadence, schedule, card, attribution,
 * scores, milestones, add-ons, depletion, dunning, cancellation history,
 * audit + event feed) plus every manual override from the core contract API,
 * each behind a confirm modal. Overrides run with STAFF actor audit and
 * idempotent form tokens so a double-click never fires twice.
 *
 * RBAC: OWNER / ADMIN / CS_AGENT (requireRole reads the staff email from the
 * authenticate.admin session).
 */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  SerializeFrom,
} from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  ButtonGroup,
  Card,
  Checkbox,
  DataTable,
  Divider,
  InlineGrid,
  InlineStack,
  Layout,
  Modal,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import {
  requireRole,
  staffEmailFromSession,
} from "~/services/core/rbac.server";
import { appendAudit } from "~/services/audit.server";
import { withIdempotency } from "~/services/idempotency.server";
import {
  gidTail,
  ShopifyGraphqlError,
  type AdminGraphql,
} from "~/services/core/shopifyClient.server";
import {
  addLineToContract,
  applyAccountCredit,
  bringForward,
  cancelContract,
  delayByWeeks,
  mergeContracts,
  pauseUntil,
  removeLineFromContract,
  resumeContract,
  sendPaymentUpdateEmail,
  setNextBillingDate,
  skipNextShipment,
  splitContract,
  swapLineVariant,
  switchCadence,
  updateDeliveryAddress,
  updateLineQuantity,
} from "~/services/core/contracts.server";
import { formatMoney } from "~/lib/money";
import {
  CANCEL_REASONS,
  PAUSE_OPTIONS_DAYS,
  parseJson,
} from "~/types/domain";
import {
  auditActionFor,
  cadenceLabel,
  churnBand,
  churnBandTone,
  DESTRUCTIVE_INTENTS,
  dunningTone,
  humanizeEnum,
  parseConsoleAction,
  qualityTone,
  scoreOutOf100,
  statusTone,
  successMessage,
  truncate,
  type CsIntent,
  type ParsedAction,
} from "~/services/subscribers/actions";

// ─────────────────────────────── Loader ───────────────────────────────────

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireRole(session, "OWNER", "ADMIN", "CS_AGENT");
  const shop = session.shop;

  const id = params.id;
  if (!id) throw new Response("Not found", { status: 404 });

  const contract = await prisma.subscriptionContract.findFirst({
    where: { id, shop },
    include: {
      lines: { include: { depletion: true }, orderBy: { createdAt: "asc" } },
      dunningState: true,
      milestones: { orderBy: { achievedAt: "desc" } },
      addOns: { orderBy: { createdAt: "desc" } },
      billingAttempts: { orderBy: { occurredAt: "desc" }, take: 10 },
    },
  });
  if (!contract) throw new Response("Not found", { status: 404 });

  const [qualitySnap, churnSnap, ltvSnap, cancellationSessions, auditRows, events, others] =
    await Promise.all([
      prisma.scoreSnapshot.findFirst({
        where: { shop, contractId: contract.id, kind: "QUALITY" },
        orderBy: { computedAt: "desc" },
      }),
      prisma.scoreSnapshot.findFirst({
        where: { shop, contractId: contract.id, kind: "CHURN_RISK" },
        orderBy: { computedAt: "desc" },
      }),
      prisma.scoreSnapshot.findFirst({
        where: { shop, contractId: contract.id, kind: "LTV" },
        orderBy: { computedAt: "desc" },
      }),
      prisma.cancellationSession.findMany({
        where: { contractId: contract.id },
        orderBy: { startedAt: "desc" },
        take: 20,
      }),
      prisma.auditLog.findMany({
        where: { shop, subjectId: contract.id },
        orderBy: { seq: "desc" },
        take: 50,
      }),
      prisma.analyticsEvent.findMany({
        where: { contractId: contract.id },
        orderBy: { occurredAt: "desc" },
        take: 50,
      }),
      prisma.subscriptionContract.findMany({
        where: {
          shop,
          shopifyCustomerId: contract.shopifyCustomerId,
          id: { not: contract.id },
          status: { in: ["ACTIVE", "PAUSED"] },
        },
        select: {
          id: true,
          status: true,
          intervalWeeks: true,
          shopifyContractId: true,
          lines: { select: { title: true, quantity: true } },
        },
      }),
    ]);

  const now = new Date();
  let cardExpiringSoon = false;
  let cardExpired = false;
  if (contract.cardExpiryYear !== null && contract.cardExpiryMonth !== null) {
    // First instant after the expiry month.
    const endOfMonth = new Date(Date.UTC(contract.cardExpiryYear, contract.cardExpiryMonth, 1));
    cardExpired = endOfMonth.getTime() <= now.getTime();
    cardExpiringSoon =
      !cardExpired &&
      endOfMonth.getTime() <= now.getTime() + 30 * 24 * 60 * 60 * 1000;
  }

  const rawAddress = parseJson<Record<string, unknown>>(contract.deliveryAddressJson, {});
  const address: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawAddress)) {
    if (typeof v === "string") address[k] = v;
  }

  const acquisition = parseJson<Record<string, unknown>>(contract.acquisitionJson, {});

  // Committed Treatment Plan detection: match the lines' selling-plan ids
  // against committed entries in SellingPlanConfig.plansJson (committed ===
  // true or minDeliveries >= 2). Kept self-contained — CS console visibility
  // only; the console itself is never gated by the commitment.
  const lineSellingPlanIds = contract.lines
    .map((l) => l.sellingPlanId)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  let committedMinDeliveries: number | null = null;
  if (lineSellingPlanIds.length > 0) {
    const planConfigs = await prisma.sellingPlanConfig.findMany({
      where: { shop },
      select: { plansJson: true },
    });
    const wanted = new Set(lineSellingPlanIds.map((id) => gidTail(id)));
    for (const cfg of planConfigs) {
      const plans = parseJson<
        Array<{ shopifyPlanId?: string; minDeliveries?: number; committed?: boolean }>
      >(cfg.plansJson, []);
      for (const p of plans) {
        const isCommitted =
          p.committed === true ||
          (typeof p.minDeliveries === "number" && p.minDeliveries >= 2);
        if (!isCommitted || typeof p.shopifyPlanId !== "string") continue;
        if (!wanted.has(gidTail(p.shopifyPlanId))) continue;
        const min =
          typeof p.minDeliveries === "number" && p.minDeliveries >= 2
            ? Math.round(p.minDeliveries)
            : 2;
        committedMinDeliveries =
          committedMinDeliveries === null
            ? min
            : Math.max(committedMinDeliveries, min);
      }
    }
  }

  return json({
    formToken: crypto.randomUUID(),
    contract: {
      id: contract.id,
      shopifyContractId: contract.shopifyContractId,
      shopifyCustomerId: contract.shopifyCustomerId,
      customerEmail: contract.customerEmail,
      status: contract.status,
      currencyCode: contract.currencyCode,
      intervalWeeks: contract.intervalWeeks,
      nextBillingDate: contract.nextBillingDate,
      nextDeliveryDate: contract.nextDeliveryDate,
      treatmentStartedAt: contract.treatmentStartedAt,
      pausedUntil: contract.pausedUntil,
      cancelledAt: contract.cancelledAt,
      cancelReason: contract.cancelReason,
      successfulOrders: contract.successfulOrders,
      failedAttempts: contract.failedAttempts,
      totalRevenueCents: contract.totalRevenueCents,
      cardBrand: contract.cardBrand,
      cardLastDigits: contract.cardLastDigits,
      cardExpiryMonth: contract.cardExpiryMonth,
      cardExpiryYear: contract.cardExpiryYear,
      cardExpiringSoon,
      cardExpired,
      autopilotEnabled: contract.autopilotEnabled,
      qualityScore: contract.qualityScore,
      churnRiskScore: contract.churnRiskScore,
      expectedLtvCents: contract.expectedLtvCents,
      originOrderId: contract.originOrderId,
      firstOrderAovCents: contract.firstOrderAovCents,
      initialDiscountPercent: contract.initialDiscountPercent,
      widgetVersion: contract.widgetVersion,
      createdAt: contract.createdAt,
      committedMinDeliveries,
      address,
      acquisitionEntries: Object.entries(acquisition).map(
        ([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)] as const,
      ),
    },
    lines: contract.lines.map((l) => ({
      id: l.id,
      title: l.title,
      quantity: l.quantity,
      currentPriceCents: l.currentPriceCents,
      shopifyProductId: l.shopifyProductId,
      shopifyVariantId: l.shopifyVariantId,
      sellingPlanName: l.sellingPlanName,
      depletion: l.depletion
        ? {
            predictedRunOutAt: l.depletion.predictedRunOutAt,
            unitsOnHand: l.depletion.unitsOnHand,
            estimatedDailyUsage: l.depletion.estimatedDailyUsage,
            confidence: l.depletion.confidence,
          }
        : null,
    })),
    addOns: contract.addOns.map((a) => ({
      id: a.id,
      title: a.title,
      quantity: a.quantity,
      priceCents: a.priceCents,
      mode: a.mode,
      remainingDeliveries: a.remainingDeliveries,
      source: a.source,
      createdAt: a.createdAt,
    })),
    milestones: contract.milestones.map((m) => ({
      id: m.id,
      type: m.type,
      achievedAt: m.achievedAt,
      rewardStatus: m.rewardStatus,
    })),
    dunning: contract.dunningState
      ? {
          phase: contract.dunningState.phase,
          declineCategory: contract.dunningState.declineCategory,
          retryCount: contract.dunningState.retryCount,
          nextRetryAt: contract.dunningState.nextRetryAt,
          graceUntil: contract.dunningState.graceUntil,
          lastFailureAt: contract.dunningState.lastFailureAt,
          history: parseJson<
            Array<{ at?: string; type?: string; stepIndex?: number; action?: string; template?: string }>
          >(contract.dunningState.historyJson, []),
        }
      : null,
    billingAttempts: contract.billingAttempts.map((b) => ({
      id: b.id,
      status: b.status,
      errorCode: b.errorCode,
      declineCategory: b.declineCategory,
      amountCents: b.amountCents,
      attemptNumber: b.attemptNumber,
      isRetry: b.isRetry,
      occurredAt: b.occurredAt,
    })),
    cancellationSessions: cancellationSessions.map((s) => ({
      id: s.id,
      startedAt: s.startedAt,
      resolvedAt: s.resolvedAt,
      reason: s.reason,
      outcome: s.outcome,
      savedByOffer: s.savedByOffer,
      saveCostCents: s.saveCostCents,
    })),
    scores: {
      quality: qualitySnap
        ? {
            value: qualitySnap.value,
            computedAt: qualitySnap.computedAt,
            factors: parseJson<Record<string, number>>(qualitySnap.factorsJson, {}),
          }
        : null,
      churn: churnSnap
        ? {
            value: churnSnap.value,
            computedAt: churnSnap.computedAt,
            factors: parseJson<Record<string, number>>(churnSnap.factorsJson, {}),
          }
        : null,
      ltv: ltvSnap
        ? {
            value: ltvSnap.value,
            computedAt: ltvSnap.computedAt,
            factors: parseJson<Record<string, number>>(ltvSnap.factorsJson, {}),
          }
        : null,
    },
    audit: auditRows.map((a) => ({
      id: a.id,
      seq: a.seq,
      action: a.action,
      actorType: a.actorType,
      actorId: a.actorId,
      createdAt: a.createdAt,
      payloadPreview: truncate(a.payloadJson, 160),
    })),
    events: events.map((e) => ({
      id: e.id,
      name: e.name,
      occurredAt: e.occurredAt,
      payloadPreview: truncate(e.payloadJson, 160),
    })),
    otherContracts: others.map((c) => ({
      id: c.id,
      label: `#${gidTail(c.shopifyContractId)} — ${humanizeEnum(c.status)}, ${cadenceLabel(
        c.intervalWeeks,
      )}, ${c.lines.length} ${c.lines.length === 1 ? "product" : "products"}`,
    })),
  });
};

// ─────────────────────────────── Action ───────────────────────────────────

async function dispatchConsoleAction(
  graphql: AdminGraphql,
  shop: string,
  contractId: string,
  act: ParsedAction,
  staffEmail: string,
): Promise<void> {
  switch (act.intent) {
    case "CHANGE_QUANTITY":
      await updateLineQuantity(graphql, shop, contractId, act.lineId, act.quantity);
      return;
    case "CHANGE_VARIANT":
      await swapLineVariant(graphql, shop, contractId, act.lineId, act.variantGid);
      return;
    case "ADD_PRODUCT":
      await addLineToContract(graphql, shop, contractId, {
        variantGid: act.variantGid,
        quantity: act.quantity,
        ...(act.priceCents !== undefined ? { priceCents: act.priceCents } : {}),
      });
      return;
    case "REMOVE_PRODUCT":
      await removeLineFromContract(graphql, shop, contractId, act.lineId);
      return;
    case "CHANGE_BILLING_DATE":
      await setNextBillingDate(graphql, shop, contractId, act.date);
      return;
    case "SKIP_SHIPMENT":
      await skipNextShipment(graphql, shop, contractId);
      return;
    case "DELAY_WEEKS":
      await delayByWeeks(graphql, shop, contractId, act.weeks);
      return;
    case "BRING_FORWARD":
      await bringForward(graphql, shop, contractId, act.date);
      return;
    case "PAUSE_UNTIL":
      await pauseUntil(graphql, shop, contractId, act.resumeDate);
      return;
    case "REACTIVATE":
      await resumeContract(graphql, shop, contractId);
      return;
    case "SWITCH_CADENCE":
      await switchCadence(graphql, shop, contractId, act.intervalWeeks);
      return;
    case "CHANGE_ADDRESS":
      await updateDeliveryAddress(
        graphql,
        shop,
        contractId,
        act.address as unknown as Parameters<typeof updateDeliveryAddress>[3],
      );
      return;
    case "UPDATE_PAYMENT_METHOD":
      await sendPaymentUpdateEmail(graphql, shop, contractId);
      return;
    case "APPLY_CREDIT":
      await applyAccountCredit(graphql, shop, contractId, act.amountCents);
      return;
    case "CANCEL":
      await cancelContract(
        graphql,
        shop,
        contractId,
        act.reason,
        { actorType: "STAFF", actorId: staffEmail } as unknown as Parameters<
          typeof cancelContract
        >[4],
      );
      return;
    case "MERGE_CONTRACTS":
      // "Merge into": this plan's products move into the selected target plan.
      await mergeContracts(graphql, shop, act.targetContractId, [contractId]);
      return;
    case "SPLIT_SHIPMENT":
      await splitContract(graphql, shop, contractId, act.lineIds);
      return;
  }
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  await requireRole(session, "OWNER", "ADMIN", "CS_AGENT");
  const shop = session.shop;
  const staffEmail = staffEmailFromSession(session) ?? `staff@${shop}`;

  const contractId = params.id;
  if (!contractId) throw new Response("Not found", { status: 404 });

  const contract = await prisma.subscriptionContract.findFirst({
    where: { id: contractId, shop },
    select: { id: true, lines: { select: { id: true } } },
  });
  if (!contract) throw new Response("Not found", { status: 404 });

  const form = await request.formData();
  const parsed = parseConsoleAction(form, {
    now: new Date(),
    selfContractId: contractId,
    totalLineCount: contract.lines.length,
  });
  if (!parsed.ok) {
    return json(
      { ok: false as const, error: parsed.error, ts: Date.now() },
      { status: 400 },
    );
  }
  const act = parsed.action;

  const graphql = admin.graphql as unknown as AdminGraphql;
  const tokenRaw = form.get("formToken");
  const formToken =
    typeof tokenRaw === "string" && tokenRaw !== "" ? tokenRaw : crypto.randomUUID();
  const idempotencyKey = `cs:${contractId}:${act.intent}:${formToken}`;

  try {
    const { replayed } = await withIdempotency(idempotencyKey, "cs-console", async () => {
      await dispatchConsoleAction(graphql, shop, contractId, act, staffEmail);
      return { intent: act.intent, at: new Date().toISOString() };
    });

    if (!replayed) {
      await appendAudit({
        shop,
        actorType: "STAFF",
        actorId: staffEmail,
        action: auditActionFor(act.intent),
        subjectType: "SubscriptionContract",
        subjectId: contractId,
        payload: act as unknown as Record<string, unknown>,
      });
    }

    return json({
      ok: true as const,
      message: successMessage(act),
      intent: act.intent,
      ts: Date.now(),
    });
  } catch (e) {
    const message =
      e instanceof ShopifyGraphqlError && e.userErrors && e.userErrors.length > 0
        ? e.userErrors.map((u) => u.message).join("; ")
        : e instanceof Error
          ? e.message
          : "Something went wrong applying this change.";
    return json({ ok: false as const, error: message, ts: Date.now() }, { status: 400 });
  }
};

// ─────────────────────────────── UI ───────────────────────────────────────

type LoaderData = SerializeFrom<typeof loader>;

interface ActiveAction {
  intent: CsIntent;
  lineId?: string;
  lineTitle?: string;
  defaultQuantity?: number;
  openedAt: number;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

const MODAL_TITLES: Record<CsIntent, string> = {
  CHANGE_QUANTITY: "Change quantity",
  CHANGE_VARIANT: "Swap variant",
  ADD_PRODUCT: "Add a product to this plan",
  REMOVE_PRODUCT: "Remove product",
  CHANGE_BILLING_DATE: "Set next billing date",
  SKIP_SHIPMENT: "Skip the next delivery",
  DELAY_WEEKS: "Delay the next delivery",
  BRING_FORWARD: "Bring the next delivery forward",
  PAUSE_UNTIL: "Pause this treatment plan",
  REACTIVATE: "Resume this treatment plan",
  SWITCH_CADENCE: "Change delivery cadence",
  CHANGE_ADDRESS: "Update delivery address",
  UPDATE_PAYMENT_METHOD: "Send payment update email",
  APPLY_CREDIT: "Apply account credit",
  CANCEL: "Cancel this treatment plan",
  MERGE_CONTRACTS: "Merge into another plan",
  SPLIT_SHIPMENT: "Split products into a new plan",
};

const SUBMIT_LABELS: Record<CsIntent, string> = {
  CHANGE_QUANTITY: "Update quantity",
  CHANGE_VARIANT: "Swap variant",
  ADD_PRODUCT: "Add product",
  REMOVE_PRODUCT: "Remove product",
  CHANGE_BILLING_DATE: "Set date",
  SKIP_SHIPMENT: "Skip delivery",
  DELAY_WEEKS: "Delay delivery",
  BRING_FORWARD: "Bring forward",
  PAUSE_UNTIL: "Pause plan",
  REACTIVATE: "Resume plan",
  SWITCH_CADENCE: "Change cadence",
  CHANGE_ADDRESS: "Update address",
  UPDATE_PAYMENT_METHOD: "Send email",
  APPLY_CREDIT: "Apply credit",
  CANCEL: "Cancel plan",
  MERGE_CONTRACTS: "Merge plans",
  SPLIT_SHIPMENT: "Split plan",
};

function ActionModal(props: {
  title: string;
  intent: CsIntent;
  formToken: string;
  destructive: boolean;
  submitLabel: string;
  error?: string;
  loading: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <Modal open title={props.title} onClose={props.onClose}>
      <Modal.Section>
        <Form method="post">
          <input type="hidden" name="intent" value={props.intent} />
          <input type="hidden" name="formToken" value={props.formToken} />
          {props.destructive ? (
            <input type="hidden" name="confirm" value={confirmed ? "yes" : ""} />
          ) : null}
          <BlockStack gap="400">
            {props.error ? (
              <Banner tone="critical" title="The change could not be applied">
                <p>{props.error}</p>
              </Banner>
            ) : null}
            {props.children}
            {props.destructive ? (
              <Checkbox
                label="I understand this change cannot be undone from the console"
                checked={confirmed}
                onChange={setConfirmed}
              />
            ) : null}
            <InlineStack align="end" gap="200">
              <Button onClick={props.onClose} disabled={props.loading}>
                Back
              </Button>
              <Button
                submit
                variant="primary"
                tone={props.destructive ? "critical" : undefined}
                disabled={props.destructive && !confirmed}
                loading={props.loading}
              >
                {props.submitLabel}
              </Button>
            </InlineStack>
          </BlockStack>
        </Form>
      </Modal.Section>
    </Modal>
  );
}

// ── Per-intent field sets (mounted fresh each time a modal opens) ──────────

function QuantityFields({ lineId, defaultQuantity }: { lineId: string; defaultQuantity: number }) {
  const [value, setValue] = useState(String(defaultQuantity));
  return (
    <BlockStack gap="300">
      <input type="hidden" name="lineId" value={lineId} />
      <TextField
        label="New quantity"
        name="quantity"
        type="number"
        min={1}
        value={value}
        onChange={setValue}
        autoComplete="off"
        autoFocus
      />
    </BlockStack>
  );
}

function VariantFields({ lineId }: { lineId: string }) {
  const [value, setValue] = useState("");
  return (
    <BlockStack gap="300">
      <input type="hidden" name="lineId" value={lineId} />
      <TextField
        label="New variant"
        name="variantGid"
        value={value}
        onChange={setValue}
        autoComplete="off"
        autoFocus
        placeholder="gid://shopify/ProductVariant/1234567890"
        helpText="Paste a variant GID or a numeric variant ID. Pricing follows the plan's selling-plan rules."
      />
    </BlockStack>
  );
}

function AddProductFields() {
  const [variant, setVariant] = useState("");
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");
  return (
    <BlockStack gap="300">
      <TextField
        label="Variant"
        name="variantGid"
        value={variant}
        onChange={setVariant}
        autoComplete="off"
        autoFocus
        placeholder="gid://shopify/ProductVariant/1234567890"
        helpText="Variant GID or numeric variant ID."
      />
      <InlineGrid columns={2} gap="300">
        <TextField
          label="Quantity"
          name="quantity"
          type="number"
          min={1}
          value={qty}
          onChange={setQty}
          autoComplete="off"
        />
        <TextField
          label="Price override (optional)"
          name="price"
          type="number"
          value={price}
          onChange={setPrice}
          autoComplete="off"
          placeholder="49.00"
          helpText="Leave empty to keep the standard plan price."
        />
      </InlineGrid>
    </BlockStack>
  );
}

function RemoveFields({ lineId, lineTitle }: { lineId: string; lineTitle: string }) {
  return (
    <BlockStack gap="300">
      <input type="hidden" name="lineId" value={lineId} />
      <Text as="p">
        {`This removes “${lineTitle}” from every future delivery of this plan. Past orders are not affected.`}
      </Text>
    </BlockStack>
  );
}

function DateFields({ label, helpText }: { label: string; helpText?: string }) {
  const [value, setValue] = useState("");
  return (
    <TextField
      label={label}
      name="date"
      type="date"
      value={value}
      onChange={setValue}
      autoComplete="off"
      autoFocus
      helpText={helpText}
    />
  );
}

function DelayFields() {
  const [weeks, setWeeks] = useState("1");
  const options = [1, 2, 3, 4, 6, 8].map((w) => ({
    label: w === 1 ? "1 week" : `${w} weeks`,
    value: String(w),
  }));
  return (
    <BlockStack gap="300">
      <Select label="Delay by" name="weeks" options={options} value={weeks} onChange={setWeeks} />
      <Text as="p" tone="subdued" variant="bodySm">
        Billing and delivery both move. The customer keeps their plan benefits.
      </Text>
    </BlockStack>
  );
}

function PauseFields() {
  const [mode, setMode] = useState(String(PAUSE_OPTIONS_DAYS[0]));
  const [date, setDate] = useState("");
  const options = [
    ...PAUSE_OPTIONS_DAYS.map((d) => ({ label: `${d} days`, value: String(d) })),
    { label: "Until a specific date", value: "CUSTOM" },
  ];
  return (
    <BlockStack gap="300">
      <Select label="Pause for" options={options} value={mode} onChange={setMode} />
      {mode === "CUSTOM" ? (
        <TextField
          label="Resume on"
          name="resumeDate"
          type="date"
          value={date}
          onChange={setDate}
          autoComplete="off"
        />
      ) : (
        <input type="hidden" name="pauseDays" value={mode} />
      )}
      <Text as="p" tone="subdued" variant="bodySm">
        Deliveries and billing stop until the resume date. The customer can resume earlier
        online at any time.
      </Text>
    </BlockStack>
  );
}

function CadenceFields({ current }: { current: number }) {
  const choices = [1, 2, 3, 4, 5, 6, 8, 10, 12];
  const initial = choices.includes(current) ? String(current) : "4";
  const [value, setValue] = useState(initial);
  const options = choices.map((w) => ({ label: cadenceLabel(w), value: String(w) }));
  return (
    <BlockStack gap="300">
      <Select
        label="Delivery cadence"
        name="intervalWeeks"
        options={options}
        value={value}
        onChange={setValue}
      />
      <Text as="p" tone="subdued" variant="bodySm">
        {`Currently ${cadenceLabel(current).toLowerCase()}. The change applies from the next billing cycle.`}
      </Text>
    </BlockStack>
  );
}

const ADDRESS_FIELDS: Array<{ name: string; label: string }> = [
  { name: "firstName", label: "First name" },
  { name: "lastName", label: "Last name" },
  { name: "address1", label: "Address line 1" },
  { name: "address2", label: "Address line 2" },
  { name: "zip", label: "Postcode / ZIP" },
  { name: "city", label: "City" },
  { name: "provinceCode", label: "Province / state code" },
  { name: "countryCode", label: "Country code (2 letters)" },
  { name: "phone", label: "Phone" },
];

function AddressFields({ address }: { address: Record<string, string> }) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const f of ADDRESS_FIELDS) initial[f.name] = address[f.name] ?? "";
    return initial;
  });
  const set = (name: string) => (v: string) => setValues((p) => ({ ...p, [name]: v }));
  return (
    <InlineGrid columns={2} gap="300">
      {ADDRESS_FIELDS.map((f) => (
        <TextField
          key={f.name}
          label={f.label}
          name={f.name}
          value={values[f.name] ?? ""}
          onChange={set(f.name)}
          autoComplete="off"
        />
      ))}
    </InlineGrid>
  );
}

function CreditFields({ currencyCode }: { currencyCode: string }) {
  const [value, setValue] = useState("");
  return (
    <BlockStack gap="300">
      <TextField
        label={`Credit amount (${currencyCode})`}
        name="amount"
        type="number"
        value={value}
        onChange={setValue}
        autoComplete="off"
        autoFocus
        placeholder="10.00"
        helpText="Applied as a one-cycle discount to the customer's next order. Capped at 500.00 per action."
      />
    </BlockStack>
  );
}

function CancelFields() {
  const [reason, setReason] = useState<string>(CANCEL_REASONS[0]);
  const options = CANCEL_REASONS.map((r) => ({ label: humanizeEnum(r), value: r }));
  return (
    <BlockStack gap="300">
      <Banner tone="warning">
        <p>
          Consider a pause, a slower cadence or a smaller delivery first — most customers
          leaving over volume or price stay when the plan adapts.
        </p>
      </Banner>
      <Select
        label="Cancellation reason"
        name="reason"
        options={options}
        value={reason}
        onChange={setReason}
      />
    </BlockStack>
  );
}

function MergeFields({ options }: { options: Array<{ id: string; label: string }> }) {
  const [target, setTarget] = useState(options[0]?.id ?? "");
  return (
    <BlockStack gap="300">
      <Select
        label="Merge into"
        name="targetContractId"
        options={options.map((o) => ({ label: o.label, value: o.id }))}
        value={target}
        onChange={setTarget}
      />
      <Text as="p" tone="subdued" variant="bodySm">
        All products from this plan move into the selected plan: one combined delivery, one
        charge. This plan is closed afterwards.
      </Text>
    </BlockStack>
  );
}

function SplitFields({
  lines,
}: {
  lines: Array<{ id: string; title: string; quantity: number }>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <BlockStack gap="300">
      <Text as="p">Choose the products to move into a new, separate plan:</Text>
      {lines.map((l) => (
        <Checkbox
          key={l.id}
          label={`${l.quantity}× ${l.title}`}
          checked={selected.includes(l.id)}
          onChange={(checked) =>
            setSelected((prev) =>
              checked ? [...prev, l.id] : prev.filter((x) => x !== l.id),
            )
          }
        />
      ))}
      {selected.map((id) => (
        <input key={id} type="hidden" name="lineIds" value={id} />
      ))}
      <Text as="p" tone="subdued" variant="bodySm">
        The new plan keeps the same cadence and payment method, with its own schedule. At
        least one product must stay in this plan.
      </Text>
    </BlockStack>
  );
}

function ActionFields({ active, data }: { active: ActiveAction; data: LoaderData }) {
  switch (active.intent) {
    case "CHANGE_QUANTITY":
      return (
        <QuantityFields
          lineId={active.lineId ?? ""}
          defaultQuantity={active.defaultQuantity ?? 1}
        />
      );
    case "CHANGE_VARIANT":
      return <VariantFields lineId={active.lineId ?? ""} />;
    case "ADD_PRODUCT":
      return <AddProductFields />;
    case "REMOVE_PRODUCT":
      return (
        <RemoveFields lineId={active.lineId ?? ""} lineTitle={active.lineTitle ?? "this product"} />
      );
    case "CHANGE_BILLING_DATE":
      return (
        <DateFields
          label="Next billing date"
          helpText={`Currently ${fmtDate(data.contract.nextBillingDate)}. Delivery follows billing.`}
        />
      );
    case "SKIP_SHIPMENT":
      return (
        <Text as="p">
          The next delivery and its charge move one full cycle later. Nothing is billed for
          the skipped cycle.
        </Text>
      );
    case "DELAY_WEEKS":
      return <DelayFields />;
    case "BRING_FORWARD":
      return (
        <DateFields
          label="New billing date"
          helpText={`Currently ${fmtDate(data.contract.nextBillingDate)}. Pick an earlier (future) date to bill and ship sooner.`}
        />
      );
    case "PAUSE_UNTIL":
      return <PauseFields />;
    case "REACTIVATE":
      return (
        <Text as="p">
          Billing and deliveries resume on the plan&apos;s regular cadence, starting from the
          next available cycle.
        </Text>
      );
    case "SWITCH_CADENCE":
      return <CadenceFields current={data.contract.intervalWeeks} />;
    case "CHANGE_ADDRESS":
      return <AddressFields address={data.contract.address} />;
    case "UPDATE_PAYMENT_METHOD":
      return (
        <Text as="p">
          {`Shopify emails ${
            data.contract.customerEmail ?? "the customer"
          } a secure link to update their card. No card details ever pass through this console.`}
        </Text>
      );
    case "APPLY_CREDIT":
      return <CreditFields currencyCode={data.contract.currencyCode} />;
    case "CANCEL":
      return <CancelFields />;
    case "MERGE_CONTRACTS":
      return <MergeFields options={data.otherContracts} />;
    case "SPLIT_SHIPMENT":
      return (
        <SplitFields
          lines={data.lines.map((l) => ({ id: l.id, title: l.title, quantity: l.quantity }))}
        />
      );
    default:
      return null;
  }
}

// ── Small display components ────────────────────────────────────────────────

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <BlockStack gap="100">
      <Text as="p" variant="bodySm" tone="subdued">
        {label}
      </Text>
      <Text as="p" variant="bodyMd">
        {value}
      </Text>
    </BlockStack>
  );
}

function FactorList({ factors }: { factors: Record<string, number> }) {
  const entries = Object.entries(factors)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 6);
  if (entries.length === 0) return null;
  return (
    <BlockStack gap="100">
      {entries.map(([k, v]) => (
        <InlineStack key={k} align="space-between">
          <Text as="span" variant="bodySm" tone="subdued">
            {k}
          </Text>
          <Text as="span" variant="bodySm">
            {`${v >= 0 ? "+" : ""}${v.toFixed(2)}`}
          </Text>
        </InlineStack>
      ))}
    </BlockStack>
  );
}

// ─────────────────────────────── Page ─────────────────────────────────────

export default function SubscriberConsole() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [active, setActive] = useState<ActiveAction | null>(null);
  const [dismissedErrorTs, setDismissedErrorTs] = useState(0);

  const submitting = navigation.state === "submitting";
  const c = data.contract;
  const cancelled = c.status === "CANCELLED";

  useEffect(() => {
    if (actionData?.ok) {
      setActive(null);
      shopify.toast.show(actionData.message);
    }
  }, [actionData, shopify]);

  const actionErr = actionData && !actionData.ok ? actionData : null;
  const modalError =
    actionErr && active && actionErr.ts > active.openedAt ? actionErr.error : undefined;
  const pageError =
    actionErr && !active && actionErr.ts > dismissedErrorTs ? actionErr.error : undefined;

  const openAction = (a: Omit<ActiveAction, "openedAt">) =>
    setActive({ ...a, openedAt: Date.now() });

  const money = (cents: number) =>
    formatMoney({ amountCents: cents, currencyCode: c.currencyCode });

  const band = churnBand(c.churnRiskScore);

  const cardSummary =
    c.cardLastDigits !== null
      ? `${c.cardBrand ?? "Card"} •••• ${c.cardLastDigits}${
          c.cardExpiryMonth !== null && c.cardExpiryYear !== null
            ? ` — exp ${String(c.cardExpiryMonth).padStart(2, "0")}/${String(
                c.cardExpiryYear,
              ).slice(-2)}`
            : ""
        }`
      : "No card on file";

  const addressSummary =
    Object.keys(c.address).length > 0
      ? [
          [c.address.firstName, c.address.lastName].filter(Boolean).join(" "),
          c.address.address1,
          c.address.address2,
          [c.address.zip, c.address.city].filter(Boolean).join(" "),
          [c.address.provinceCode, c.address.countryCode].filter(Boolean).join(", "),
        ]
          .filter((part) => part && part !== "")
          .join(" · ")
      : "No delivery address on file";

  return (
    <Page
      title={c.customerEmail ?? "Subscriber"}
      subtitle={`Treatment plan #${gidTailClient(c.shopifyContractId)} · started ${fmtDate(
        c.treatmentStartedAt ?? c.createdAt,
      )}`}
      titleMetadata={<Badge tone={statusTone(c.status)}>{humanizeEnum(c.status)}</Badge>}
      backAction={{ content: "Subscribers", url: "/app/subscribers" }}
    >
      <BlockStack gap="400">
        {pageError && actionErr ? (
          <Banner
            tone="critical"
            title="The change could not be applied"
            onDismiss={() => setDismissedErrorTs(actionErr.ts)}
          >
            <p>{pageError}</p>
          </Banner>
        ) : null}

        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              {/* Plan overview */}
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Treatment plan
                    </Text>
                    <InlineStack gap="200">
                      {c.committedMinDeliveries !== null ? (
                        <Badge tone="info">
                          {`Committed · ${c.successfulOrders}/${c.committedMinDeliveries} deliveries`}
                        </Badge>
                      ) : null}
                      {c.autopilotEnabled ? <Badge tone="info">Autopilot</Badge> : null}
                      {c.pausedUntil ? (
                        <Badge tone="attention">{`Paused until ${fmtDate(c.pausedUntil)}`}</Badge>
                      ) : null}
                    </InlineStack>
                  </InlineStack>
                  <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="300">
                    <InfoItem label="Cadence" value={cadenceLabel(c.intervalWeeks)} />
                    <InfoItem label="Next billing" value={fmtDate(c.nextBillingDate)} />
                    <InfoItem label="Next delivery" value={fmtDate(c.nextDeliveryDate)} />
                    <InfoItem label="Successful orders" value={String(c.successfulOrders)} />
                    <InfoItem label="Failed attempts" value={String(c.failedAttempts)} />
                    <InfoItem label="Lifetime revenue" value={money(c.totalRevenueCents)} />
                  </InlineGrid>
                  <Divider />
                  <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Payment method
                      </Text>
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="p" variant="bodyMd">
                          {cardSummary}
                        </Text>
                        {c.cardExpired ? (
                          <Badge tone="critical">Expired</Badge>
                        ) : c.cardExpiringSoon ? (
                          <Badge tone="warning">Expiring soon</Badge>
                        ) : null}
                      </InlineStack>
                    </BlockStack>
                    <InfoItem label="Delivery address" value={addressSummary} />
                  </InlineGrid>
                  {cancelled ? (
                    <Banner tone="info">
                      <p>
                        {`Cancelled ${fmtDate(c.cancelledAt)}${
                          c.cancelReason ? ` — ${humanizeEnum(c.cancelReason)}` : ""
                        }.`}
                      </p>
                    </Banner>
                  ) : null}
                </BlockStack>
              </Card>

              {/* Products */}
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Products in this plan
                    </Text>
                    <Button
                      onClick={() => openAction({ intent: "ADD_PRODUCT" })}
                      disabled={cancelled}
                    >
                      Add product
                    </Button>
                  </InlineStack>
                  {data.lines.length === 0 ? (
                    <Text as="p" tone="subdued">
                      No products on this plan.
                    </Text>
                  ) : (
                    <DataTable
                      columnContentTypes={["text", "numeric", "numeric", "text", "text"]}
                      headings={["Product", "Qty", "Price", "Estimated run-out", "Actions"]}
                      rows={data.lines.map((l) => [
                        <BlockStack gap="100" key={`t-${l.id}`}>
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            {l.title}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {l.sellingPlanName ?? "No selling plan name"}
                          </Text>
                        </BlockStack>,
                        l.quantity,
                        money(l.currentPriceCents),
                        l.depletion?.predictedRunOutAt
                          ? `${fmtDate(l.depletion.predictedRunOutAt)} (${Math.round(
                              l.depletion.confidence * 100,
                            )}% conf.)`
                          : "—",
                        <ButtonGroup key={`a-${l.id}`}>
                          <Button
                            size="slim"
                            disabled={cancelled}
                            onClick={() =>
                              openAction({
                                intent: "CHANGE_QUANTITY",
                                lineId: l.id,
                                lineTitle: l.title,
                                defaultQuantity: l.quantity,
                              })
                            }
                          >
                            Quantity
                          </Button>
                          <Button
                            size="slim"
                            disabled={cancelled}
                            onClick={() =>
                              openAction({
                                intent: "CHANGE_VARIANT",
                                lineId: l.id,
                                lineTitle: l.title,
                              })
                            }
                          >
                            Swap
                          </Button>
                          <Button
                            size="slim"
                            tone="critical"
                            disabled={cancelled}
                            onClick={() =>
                              openAction({
                                intent: "REMOVE_PRODUCT",
                                lineId: l.id,
                                lineTitle: l.title,
                              })
                            }
                          >
                            Remove
                          </Button>
                        </ButtonGroup>,
                      ])}
                    />
                  )}
                </BlockStack>
              </Card>

              {/* Add-ons */}
              {data.addOns.length > 0 ? (
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">
                      Add-ons
                    </Text>
                    <DataTable
                      columnContentTypes={["text", "numeric", "numeric", "text", "text"]}
                      headings={["Item", "Qty", "Price", "Mode", "Source"]}
                      rows={data.addOns.map((a) => [
                        a.title,
                        a.quantity,
                        money(a.priceCents),
                        a.mode === "N_DELIVERIES" && a.remainingDeliveries !== null
                          ? `${humanizeEnum(a.mode)} (${a.remainingDeliveries} left)`
                          : humanizeEnum(a.mode),
                        `${a.source} · ${fmtDate(a.createdAt)}`,
                      ])}
                    />
                  </BlockStack>
                </Card>
              ) : null}

              {/* Payment recovery */}
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Payment recovery
                    </Text>
                    {data.dunning ? (
                      <Badge tone={dunningTone(data.dunning.phase)}>
                        {humanizeEnum(data.dunning.phase)}
                      </Badge>
                    ) : null}
                  </InlineStack>
                  {!data.dunning || data.dunning.phase === "NONE" ? (
                    <Text as="p" tone="subdued">
                      No payment recovery activity on this plan.
                    </Text>
                  ) : (
                    <BlockStack gap="300">
                      <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
                        <InfoItem
                          label="Decline category"
                          value={
                            data.dunning.declineCategory
                              ? humanizeEnum(data.dunning.declineCategory)
                              : "—"
                          }
                        />
                        <InfoItem label="Retries" value={String(data.dunning.retryCount)} />
                        <InfoItem label="Next retry" value={fmtDateTime(data.dunning.nextRetryAt)} />
                        <InfoItem label="Grace until" value={fmtDate(data.dunning.graceUntil)} />
                      </InlineGrid>
                      {data.dunning.history.length > 0 ? (
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingSm">
                            Recovery timeline
                          </Text>
                          {data.dunning.history.map((h, i) => (
                            <InlineStack key={i} gap="200" blockAlign="center" wrap={false}>
                              <Text as="span" variant="bodySm" tone="subdued">
                                {h.at ? fmtDateTime(h.at) : "—"}
                              </Text>
                              <Text as="span" variant="bodySm">
                                {h.type && h.type !== "STEP"
                                  ? humanizeEnum(h.type)
                                  : [h.action, h.template].filter(Boolean).join(" · ") || "Step"}
                              </Text>
                            </InlineStack>
                          ))}
                        </BlockStack>
                      ) : null}
                    </BlockStack>
                  )}
                  {data.billingAttempts.length > 0 ? (
                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">
                        Recent billing attempts
                      </Text>
                      <DataTable
                        columnContentTypes={["text", "text", "numeric", "text", "text"]}
                        headings={["When", "Status", "Amount", "Error", "Attempt"]}
                        rows={data.billingAttempts.map((b) => [
                          fmtDateTime(b.occurredAt),
                          <Badge
                            key={b.id}
                            tone={
                              b.status === "SUCCESS"
                                ? "success"
                                : b.status === "PENDING"
                                  ? "info"
                                  : "critical"
                            }
                          >
                            {humanizeEnum(b.status)}
                          </Badge>,
                          b.amountCents !== null ? money(b.amountCents) : "—",
                          b.errorCode ?? "—",
                          `${b.attemptNumber}${b.isRetry ? " (retry)" : ""}`,
                        ])}
                      />
                    </BlockStack>
                  ) : null}
                </BlockStack>
              </Card>

              {/* Cancellation sessions */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Cancellation history
                  </Text>
                  {data.cancellationSessions.length === 0 ? (
                    <Text as="p" tone="subdued">
                      This customer has never started a cancellation.
                    </Text>
                  ) : (
                    <DataTable
                      columnContentTypes={["text", "text", "text", "text", "numeric"]}
                      headings={["Started", "Reason", "Outcome", "Saved by", "Save cost"]}
                      rows={data.cancellationSessions.map((s) => [
                        fmtDateTime(s.startedAt),
                        s.reason ? humanizeEnum(s.reason) : "—",
                        <Badge
                          key={s.id}
                          tone={
                            s.outcome === "SAVED"
                              ? "success"
                              : s.outcome === "CANCELLED"
                                ? "critical"
                                : s.outcome === "IN_PROGRESS"
                                  ? "attention"
                                  : undefined
                          }
                        >
                          {humanizeEnum(s.outcome)}
                        </Badge>,
                        s.savedByOffer ? humanizeEnum(s.savedByOffer) : "—",
                        s.saveCostCents !== null ? money(s.saveCostCents) : "—",
                      ])}
                    />
                  )}
                </BlockStack>
              </Card>

              {/* Change history (audit) */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Change history
                  </Text>
                  {data.audit.length === 0 ? (
                    <Text as="p" tone="subdued">
                      No recorded changes yet.
                    </Text>
                  ) : (
                    <BlockStack gap="300">
                      {data.audit.map((a) => (
                        <BlockStack key={a.id} gap="100">
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="span" variant="bodyMd" fontWeight="semibold">
                              {a.action}
                            </Text>
                            <Badge size="small">{humanizeEnum(a.actorType)}</Badge>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {`${a.actorId ?? "system"} · ${fmtDateTime(a.createdAt)} · #${a.seq}`}
                            </Text>
                          </InlineStack>
                          {a.payloadPreview !== "{}" ? (
                            <Text as="p" variant="bodySm" tone="subdued">
                              {a.payloadPreview}
                            </Text>
                          ) : null}
                        </BlockStack>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>

              {/* Event feed */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Event feed
                  </Text>
                  {data.events.length === 0 ? (
                    <Text as="p" tone="subdued">
                      No lifecycle events recorded for this plan yet.
                    </Text>
                  ) : (
                    <BlockStack gap="300">
                      {data.events.map((e) => (
                        <BlockStack key={e.id} gap="100">
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="span" variant="bodyMd" fontWeight="semibold">
                              {humanizeEnum(e.name)}
                            </Text>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {fmtDateTime(e.occurredAt)}
                            </Text>
                          </InlineStack>
                          {e.payloadPreview !== "{}" ? (
                            <Text as="p" variant="bodySm" tone="subdued">
                              {e.payloadPreview}
                            </Text>
                          ) : null}
                        </BlockStack>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              {/* Console actions */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Console actions
                  </Text>

                  <Text as="h3" variant="bodySm" tone="subdued">
                    SCHEDULE
                  </Text>
                  <BlockStack gap="200">
                    <Button
                      fullWidth
                      textAlign="left"
                      disabled={cancelled}
                      onClick={() => openAction({ intent: "CHANGE_BILLING_DATE" })}
                    >
                      Set next billing date
                    </Button>
                    <Button
                      fullWidth
                      textAlign="left"
                      disabled={cancelled}
                      onClick={() => openAction({ intent: "SKIP_SHIPMENT" })}
                    >
                      Skip next delivery
                    </Button>
                    <Button
                      fullWidth
                      textAlign="left"
                      disabled={cancelled}
                      onClick={() => openAction({ intent: "DELAY_WEEKS" })}
                    >
                      Delay by weeks
                    </Button>
                    <Button
                      fullWidth
                      textAlign="left"
                      disabled={cancelled}
                      onClick={() => openAction({ intent: "BRING_FORWARD" })}
                    >
                      Bring delivery forward
                    </Button>
                  </BlockStack>

                  <Text as="h3" variant="bodySm" tone="subdued">
                    PLAN
                  </Text>
                  <BlockStack gap="200">
                    <Button
                      fullWidth
                      textAlign="left"
                      disabled={cancelled}
                      onClick={() => openAction({ intent: "SWITCH_CADENCE" })}
                    >
                      Change cadence
                    </Button>
                    <Button
                      fullWidth
                      textAlign="left"
                      disabled={cancelled || c.status === "PAUSED"}
                      onClick={() => openAction({ intent: "PAUSE_UNTIL" })}
                    >
                      Pause plan
                    </Button>
                    <Button
                      fullWidth
                      textAlign="left"
                      disabled={c.status !== "PAUSED"}
                      onClick={() => openAction({ intent: "REACTIVATE" })}
                    >
                      Resume plan
                    </Button>
                    <Button
                      fullWidth
                      textAlign="left"
                      disabled={cancelled || data.lines.length < 2}
                      onClick={() => openAction({ intent: "SPLIT_SHIPMENT" })}
                    >
                      Split into a new plan
                    </Button>
                    <Button
                      fullWidth
                      textAlign="left"
                      disabled={cancelled || data.otherContracts.length === 0}
                      onClick={() => openAction({ intent: "MERGE_CONTRACTS" })}
                    >
                      Merge into another plan
                    </Button>
                  </BlockStack>

                  <Text as="h3" variant="bodySm" tone="subdued">
                    PAYMENT & DELIVERY
                  </Text>
                  <BlockStack gap="200">
                    <Button
                      fullWidth
                      textAlign="left"
                      disabled={cancelled}
                      onClick={() => openAction({ intent: "UPDATE_PAYMENT_METHOD" })}
                    >
                      Send payment update email
                    </Button>
                    <Button
                      fullWidth
                      textAlign="left"
                      disabled={cancelled}
                      onClick={() => openAction({ intent: "APPLY_CREDIT" })}
                    >
                      Apply account credit
                    </Button>
                    <Button
                      fullWidth
                      textAlign="left"
                      disabled={cancelled}
                      onClick={() => openAction({ intent: "CHANGE_ADDRESS" })}
                    >
                      Update delivery address
                    </Button>
                  </BlockStack>

                  <Divider />
                  <Button
                    fullWidth
                    tone="critical"
                    disabled={cancelled}
                    onClick={() => openAction({ intent: "CANCEL" })}
                  >
                    Cancel treatment plan
                  </Button>
                </BlockStack>
              </Card>

              {/* Scores */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Scores
                  </Text>

                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="p" variant="bodyMd">
                        Treatment quality
                      </Text>
                      {c.qualityScore !== null || data.scores.quality ? (
                        <Badge tone={qualityTone(data.scores.quality?.value ?? c.qualityScore)}>
                          {String(
                            scoreOutOf100(data.scores.quality?.value ?? c.qualityScore ?? 0),
                          )}
                        </Badge>
                      ) : (
                        <Badge>Not scored</Badge>
                      )}
                    </InlineStack>
                    {data.scores.quality ? (
                      <FactorList factors={data.scores.quality.factors} />
                    ) : null}
                  </BlockStack>

                  <Divider />

                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="p" variant="bodyMd">
                        Churn risk
                      </Text>
                      {c.churnRiskScore !== null || data.scores.churn ? (
                        <Badge tone={churnBandTone(band)}>
                          {`${humanizeEnum(band)} · ${scoreOutOf100(
                            data.scores.churn?.value ?? c.churnRiskScore ?? 0,
                          )}`}
                        </Badge>
                      ) : (
                        <Badge>Not scored</Badge>
                      )}
                    </InlineStack>
                    {data.scores.churn ? <FactorList factors={data.scores.churn.factors} /> : null}
                  </BlockStack>

                  <Divider />

                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="p" variant="bodyMd">
                        Expected LTV
                      </Text>
                      <Text as="p" variant="bodyMd" fontWeight="semibold">
                        {c.expectedLtvCents !== null ? money(c.expectedLtvCents) : "—"}
                      </Text>
                    </InlineStack>
                    {data.scores.ltv ? <FactorList factors={data.scores.ltv.factors} /> : null}
                  </BlockStack>
                </BlockStack>
              </Card>

              {/* Customer & acquisition */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Customer & acquisition
                  </Text>
                  <InfoItem label="Email" value={c.customerEmail ?? "—"} />
                  <InfoItem
                    label="Shopify customer"
                    value={gidTailClient(c.shopifyCustomerId)}
                  />
                  <InfoItem
                    label="Origin order"
                    value={c.originOrderId ? gidTailClient(c.originOrderId) : "—"}
                  />
                  <InlineGrid columns={2} gap="300">
                    <InfoItem
                      label="First order AOV"
                      value={c.firstOrderAovCents !== null ? money(c.firstOrderAovCents) : "—"}
                    />
                    <InfoItem
                      label="Initial discount"
                      value={
                        c.initialDiscountPercent !== null
                          ? `${c.initialDiscountPercent}%`
                          : "—"
                      }
                    />
                  </InlineGrid>
                  <InfoItem label="Widget version" value={c.widgetVersion ?? "—"} />
                  {c.acquisitionEntries.length > 0 ? (
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Attribution
                      </Text>
                      {c.acquisitionEntries.map(([k, v]) => (
                        <InlineStack key={k} align="space-between">
                          <Text as="span" variant="bodySm" tone="subdued">
                            {k}
                          </Text>
                          <Text as="span" variant="bodySm">
                            {truncate(v, 40)}
                          </Text>
                        </InlineStack>
                      ))}
                    </BlockStack>
                  ) : null}
                </BlockStack>
              </Card>

              {/* Milestones */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Milestones
                  </Text>
                  {data.milestones.length === 0 ? (
                    <Text as="p" tone="subdued">
                      No milestones reached yet.
                    </Text>
                  ) : (
                    <BlockStack gap="200">
                      {data.milestones.map((m) => (
                        <InlineStack key={m.id} align="space-between" blockAlign="center">
                          <Text as="span" variant="bodyMd">
                            {humanizeEnum(m.type)}
                          </Text>
                          <InlineStack gap="200" blockAlign="center">
                            <Badge
                              tone={m.rewardStatus === "PENDING" ? "attention" : "success"}
                              size="small"
                            >
                              {humanizeEnum(m.rewardStatus)}
                            </Badge>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {fmtDate(m.achievedAt)}
                            </Text>
                          </InlineStack>
                        </InlineStack>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>

      {active ? (
        <ActionModal
          title={
            active.lineTitle
              ? `${MODAL_TITLES[active.intent]} — ${active.lineTitle}`
              : MODAL_TITLES[active.intent]
          }
          intent={active.intent}
          formToken={data.formToken}
          destructive={DESTRUCTIVE_INTENTS.includes(active.intent)}
          submitLabel={SUBMIT_LABELS[active.intent]}
          error={modalError}
          loading={submitting}
          onClose={() => setActive(null)}
        >
          <ActionFields active={active} data={data} />
        </ActionModal>
      ) : null}
    </Page>
  );
}

/** Client-safe GID tail (mirror of core's gidTail, kept local to the view). */
function gidTailClient(gid: string): string {
  const idx = gid.lastIndexOf("/");
  return idx === -1 ? gid : gid.slice(idx + 1);
}
