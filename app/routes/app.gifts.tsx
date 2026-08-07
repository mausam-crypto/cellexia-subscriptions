import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useFetcher,
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
  EmptyState,
  InlineStack,
  Layout,
  Modal,
  Page,
  Select,
  Tag,
  Text,
  TextField,
} from "@shopify/polaris";
import { z } from "zod";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { getSetting } from "~/lib/settings/settings.server";
import { logEvent } from "~/lib/events/log.server";
import { centsFromDecimalString, formatMoney } from "~/lib/money";
import { searchProducts } from "~/lib/graphql/index.server";

/**
 * Admin — Gift rules.
 *
 * GiftRule CRUD (trigger + variant + COGS + announce flag) plus a read-only
 * view of recent GiftGrants. Gifts are the cheapest retention lever we have:
 * a surprise on cycle 2 (peak early-churn), a milestone at order 6 and a
 * 365-day anniversary — the banner offers one-click prefills for those.
 */

// ── View types ───────────────────────────────────────────────────────────────

interface RuleView {
  id: string;
  name: string;
  trigger: string;
  orderIndex: number | null;
  daysSubscribed: number | null;
  variantId: string;
  variantTitle: string | null;
  unitCostCents: number;
  announceInAdvance: boolean;
  active: boolean;
}

interface GrantView {
  id: string;
  email: string;
  ruleName: string | null;
  cycleIndex: number;
  status: string;
  createdAt: string;
}

interface SearchVariantView {
  id: string;
  title: string;
  priceCents: number;
  availableForSale: boolean;
}

interface SearchProductView {
  id: string;
  title: string;
  variants: SearchVariantView[];
}

interface ActionData {
  intent: string;
  ok: boolean;
  toast?: string;
  errors?: Record<string, string>;
  searchResults?: SearchProductView[];
}

// ── Validation ───────────────────────────────────────────────────────────────

const TRIGGERS = [
  "ORDER_INDEX",
  "DAYS_SUBSCRIBED",
  "SAVE_FLOW",
  "WINBACK",
  "MANUAL",
] as const;

const ruleSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(120),
    trigger: z.enum(TRIGGERS, {
      errorMap: () => ({ message: "Pick a trigger" }),
    }),
    orderIndex: z
      .number()
      .int("Whole order numbers only")
      .min(1, "Order number must be at least 1")
      .max(48, "Order number must be 48 or less")
      .nullable(),
    daysSubscribed: z
      .number()
      .int("Whole days only")
      .min(1, "Days must be at least 1")
      .max(2000, "Days must be 2000 or less")
      .nullable(),
    variantId: z
      .string()
      .regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/, "Pick a gift variant"),
    variantTitle: z.string().trim().max(200).nullable(),
    unitCostCents: z
      .number()
      .int()
      .min(0, "COGS cannot be negative")
      .max(10_000_000, "COGS looks too large"),
    announceInAdvance: z.boolean(),
    active: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.trigger === "ORDER_INDEX" && value.orderIndex == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["orderIndex"],
        message: "Which order number should the gift ship with?",
      });
    }
    if (value.trigger === "DAYS_SUBSCRIBED" && value.daysSubscribed == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["daysSubscribed"],
        message: "After how many subscribed days?",
      });
    }
  });

function actorFromSession(session: {
  shop: string;
  onlineAccessInfo?: { associated_user?: { email?: string | null } } | null;
}): string {
  return session.onlineAccessInfo?.associated_user?.email ?? `admin@${session.shop}`;
}

function optionalIntFrom(formData: FormData, name: string): number | null {
  const raw = String(formData.get(name) ?? "").trim();
  if (raw === "") return null;
  return Number(raw);
}

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }

  const [rules, grants, lifecycle] = await Promise.all([
    prisma.giftRule.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "asc" },
    }),
    prisma.giftGrant.findMany({
      where: { contract: { shopId: shop.id } },
      orderBy: { createdAt: "desc" },
      take: 25,
      include: {
        contract: { select: { email: true } },
        rule: { select: { name: true } },
      },
    }),
    getSetting(shop.id, "lifecycle"),
  ]);

  const ruleViews: RuleView[] = rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    trigger: rule.trigger,
    orderIndex: rule.orderIndex,
    daysSubscribed: rule.daysSubscribed,
    variantId: rule.variantId,
    variantTitle: rule.variantTitle,
    unitCostCents: rule.unitCostCents,
    announceInAdvance: rule.announceInAdvance,
    active: rule.active,
  }));

  const grantViews: GrantView[] = grants.map((grant) => ({
    id: grant.id,
    email: grant.contract.email,
    ruleName: grant.rule?.name ?? null,
    cycleIndex: grant.cycleIndex,
    status: grant.status,
    createdAt: grant.createdAt.toISOString().slice(0, 10),
  }));

  return json({
    currencyCode: shop.currencyCode,
    rules: ruleViews,
    grants: grantViews,
    lifecycle: {
      surpriseGiftOnCycle2: lifecycle.surpriseGiftOnCycle2,
      milestoneGiftCycle: lifecycle.milestoneGiftCycle,
      anniversaryGiftDays: lifecycle.anniversaryGiftDays,
    },
  });
};

// ── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }
  const actor = actorFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "search-products") {
    const query = String(formData.get("query") ?? "").trim();
    if (!query) return json<ActionData>({ intent, ok: true, searchResults: [] });
    try {
      const results = await searchProducts(admin, query, 12);
      return json<ActionData>({
        intent,
        ok: true,
        searchResults: results.map((p) => ({
          id: p.id,
          title: p.title,
          variants: p.variants.map((v) => ({
            id: v.id,
            title: v.title,
            priceCents: v.priceCents,
            availableForSale: v.availableForSale,
          })),
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json<ActionData>({
        intent,
        ok: false,
        toast: `Product search failed: ${message}`,
      });
    }
  }

  if (intent === "save-rule") {
    const unitCostRaw = String(formData.get("unitCost") ?? "").trim();
    const unitCostCents =
      unitCostRaw === "" ? 0 : centsFromDecimalString(unitCostRaw);
    const variantTitleRaw = String(formData.get("variantTitle") ?? "").trim();
    const candidate = {
      name: String(formData.get("name") ?? ""),
      trigger: String(formData.get("trigger") ?? ""),
      orderIndex: optionalIntFrom(formData, "orderIndex"),
      daysSubscribed: optionalIntFrom(formData, "daysSubscribed"),
      variantId: String(formData.get("variantId") ?? "").trim(),
      variantTitle: variantTitleRaw === "" ? null : variantTitleRaw,
      unitCostCents: Number.isNaN(unitCostCents) ? -1 : unitCostCents,
      announceInAdvance: formData.get("announceInAdvance") === "true",
      active: formData.get("active") === "true",
    };
    const parsed = ruleSchema.safeParse(candidate);
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "form");
        if (!errors[key]) errors[key] = issue.message;
      }
      if (candidate.unitCostCents === -1) {
        errors.unitCost = "COGS must be a decimal amount, e.g. 4.50";
      }
      return json<ActionData>({ intent, ok: false, errors }, { status: 422 });
    }
    const values = parsed.data;
    // Keep only the field matching the trigger; the rest are noise.
    const orderIndex =
      values.trigger === "ORDER_INDEX" ? values.orderIndex : null;
    const daysSubscribed =
      values.trigger === "DAYS_SUBSCRIBED" ? values.daysSubscribed : null;

    const ruleId = String(formData.get("ruleId") ?? "");
    const data = {
      name: values.name,
      trigger: values.trigger,
      orderIndex,
      daysSubscribed,
      variantId: values.variantId,
      variantTitle: values.variantTitle,
      unitCostCents: values.unitCostCents,
      announceInAdvance: values.announceInAdvance,
      active: values.active,
    };

    let saved;
    if (ruleId) {
      const existing = await prisma.giftRule.findFirst({
        where: { id: ruleId, shopId: shop.id },
      });
      if (!existing) {
        return json<ActionData>(
          { intent, ok: false, toast: "Gift rule not found" },
          { status: 404 },
        );
      }
      saved = await prisma.giftRule.update({ where: { id: ruleId }, data });
    } else {
      saved = await prisma.giftRule.create({
        data: { shopId: shop.id, ...data },
      });
    }

    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "ADMIN",
      actor,
      payload: {
        action: ruleId ? "gift_rule_updated" : "gift_rule_created",
        giftRuleId: saved.id,
        name: saved.name,
        trigger: saved.trigger,
        orderIndex: saved.orderIndex,
        daysSubscribed: saved.daysSubscribed,
        variantId: saved.variantId,
        unitCostCents: saved.unitCostCents,
      },
    });

    return json<ActionData>({ intent, ok: true, toast: "Gift rule saved" });
  }

  if (intent === "toggle-rule") {
    const ruleId = String(formData.get("ruleId") ?? "");
    const active = formData.get("active") === "true";
    const existing = await prisma.giftRule.findFirst({
      where: { id: ruleId, shopId: shop.id },
    });
    if (!existing) {
      return json<ActionData>(
        { intent, ok: false, toast: "Gift rule not found" },
        { status: 404 },
      );
    }
    await prisma.giftRule.update({
      where: { id: ruleId },
      data: { active },
    });
    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "ADMIN",
      actor,
      payload: {
        action: active ? "gift_rule_activated" : "gift_rule_deactivated",
        giftRuleId: ruleId,
        name: existing.name,
      },
    });
    return json<ActionData>({
      intent,
      ok: true,
      toast: active ? "Rule activated" : "Rule deactivated",
    });
  }

  if (intent === "delete-rule") {
    const ruleId = String(formData.get("ruleId") ?? "");
    const existing = await prisma.giftRule.findFirst({
      where: { id: ruleId, shopId: shop.id },
    });
    if (!existing) {
      return json<ActionData>(
        { intent, ok: false, toast: "Gift rule not found" },
        { status: 404 },
      );
    }
    await prisma.giftRule.delete({ where: { id: ruleId } });
    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "ADMIN",
      actor,
      payload: {
        action: "gift_rule_deleted",
        giftRuleId: ruleId,
        name: existing.name,
      },
    });
    return json<ActionData>({
      intent,
      ok: true,
      toast: "Gift rule deleted — past grants are kept for the audit trail",
    });
  }

  return json<ActionData>(
    { intent, ok: false, toast: "Unknown action" },
    { status: 400 },
  );
};

// ── Variant picker ───────────────────────────────────────────────────────────

function GiftVariantPicker({
  currencyCode,
  selectedId,
  selectedLabel,
  error,
  onSelect,
  onClear,
}: {
  currencyCode: string;
  selectedId: string | null;
  selectedLabel: string | null;
  error?: string;
  onSelect: (variantId: string, label: string) => void;
  onClear: () => void;
}) {
  const fetcher = useFetcher<ActionData>();
  const [query, setQuery] = useState("");

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const handle = setTimeout(() => {
      fetcher.submit(
        { intent: "search-products", query: q },
        { method: "post" },
      );
    }, 350);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const results = fetcher.data?.searchResults ?? [];

  if (selectedId) {
    return (
      <BlockStack gap="100">
        <Text as="p" variant="bodyMd" fontWeight="medium">
          Gift variant
        </Text>
        <InlineStack gap="150">
          <Tag onRemove={onClear}>{selectedLabel ?? selectedId}</Tag>
        </InlineStack>
      </BlockStack>
    );
  }

  return (
    <BlockStack gap="200">
      <TextField
        label="Gift variant"
        autoComplete="off"
        value={query}
        onChange={setQuery}
        placeholder="Search for the gift product…"
        helpText="Added to the qualifying order as a zero-priced line."
        loading={fetcher.state !== "idle"}
        error={error}
      />
      {results.length > 0 && query.trim().length >= 2 ? (
        <Box
          borderColor="border"
          borderWidth="025"
          borderRadius="200"
          padding="150"
        >
          <BlockStack gap="100">
            {results.flatMap((product) =>
              product.variants.map((variant) => {
                const label =
                  variant.title && variant.title !== "Default Title"
                    ? `${product.title} — ${variant.title}`
                    : product.title;
                return (
                  <Button
                    key={variant.id}
                    variant="tertiary"
                    textAlign="left"
                    fullWidth
                    onClick={() => onSelect(variant.id, label)}
                  >
                    {`${label} (${formatMoney(variant.priceCents, currencyCode)})`}
                  </Button>
                );
              }),
            )}
          </BlockStack>
        </Box>
      ) : null}
    </BlockStack>
  );
}

// ── Rule form modal ──────────────────────────────────────────────────────────

interface RulePrefill {
  name: string;
  trigger: (typeof TRIGGERS)[number];
  orderIndex: number | null;
  daysSubscribed: number | null;
}

const TRIGGER_OPTIONS = [
  { label: "With a specific order number", value: "ORDER_INDEX" },
  { label: "After N days subscribed", value: "DAYS_SUBSCRIBED" },
  { label: "Cancel-flow save perk", value: "SAVE_FLOW" },
  { label: "Win-back perk", value: "WINBACK" },
  { label: "Manual (granted by hand)", value: "MANUAL" },
];

function triggerHuman(rule: RuleView): string {
  switch (rule.trigger) {
    case "ORDER_INDEX":
      return `With order #${rule.orderIndex ?? "?"}`;
    case "DAYS_SUBSCRIBED":
      return `After ${rule.daysSubscribed ?? "?"} days subscribed`;
    case "SAVE_FLOW":
      return "Cancel-flow save perk";
    case "WINBACK":
      return "Win-back perk";
    case "MANUAL":
      return "Manual";
    default:
      return rule.trigger;
  }
}

function RuleFormModal({
  rule,
  prefill,
  open,
  currencyCode,
  errors,
  saving,
  onClose,
  onSave,
}: {
  rule: RuleView | null;
  prefill: RulePrefill | null;
  open: boolean;
  currencyCode: string;
  errors: Record<string, string>;
  saving: boolean;
  onClose: () => void;
  onSave: (fd: FormData) => void;
}) {
  const [name, setName] = useState(rule?.name ?? prefill?.name ?? "");
  const [trigger, setTrigger] = useState<string>(
    rule?.trigger ?? prefill?.trigger ?? "ORDER_INDEX",
  );
  const [orderIndex, setOrderIndex] = useState(
    String(rule?.orderIndex ?? prefill?.orderIndex ?? 2),
  );
  const [daysSubscribed, setDaysSubscribed] = useState(
    String(rule?.daysSubscribed ?? prefill?.daysSubscribed ?? 365),
  );
  const [variantId, setVariantId] = useState<string | null>(
    rule?.variantId ?? null,
  );
  const [variantTitle, setVariantTitle] = useState<string | null>(
    rule?.variantTitle ?? null,
  );
  const [unitCost, setUnitCost] = useState(
    rule ? (rule.unitCostCents / 100).toFixed(2) : "",
  );
  const [announce, setAnnounce] = useState(rule?.announceInAdvance ?? false);
  const [active, setActive] = useState(rule?.active ?? true);

  const handleSave = () => {
    const fd = new FormData();
    fd.set("intent", "save-rule");
    if (rule) fd.set("ruleId", rule.id);
    fd.set("name", name);
    fd.set("trigger", trigger);
    fd.set("orderIndex", trigger === "ORDER_INDEX" ? orderIndex : "");
    fd.set(
      "daysSubscribed",
      trigger === "DAYS_SUBSCRIBED" ? daysSubscribed : "",
    );
    fd.set("variantId", variantId ?? "");
    fd.set("variantTitle", variantTitle ?? "");
    fd.set("unitCost", unitCost);
    fd.set("announceInAdvance", String(announce));
    fd.set("active", String(active));
    onSave(fd);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={rule ? `Edit "${rule.name}"` : "Create gift rule"}
      primaryAction={{
        content: "Save rule",
        onAction: handleSave,
        loading: saving,
      }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <TextField
            label="Rule name"
            autoComplete="off"
            value={name}
            onChange={setName}
            error={errors.name}
          />
          <Select
            label="Trigger"
            options={TRIGGER_OPTIONS}
            value={trigger}
            onChange={setTrigger}
            error={errors.trigger}
            helpText="When the gift engine schedules this gift onto a contract's upcoming cycle."
          />
          {trigger === "ORDER_INDEX" ? (
            <TextField
              label="Order number"
              autoComplete="off"
              type="number"
              min={1}
              max={48}
              value={orderIndex}
              onChange={setOrderIndex}
              error={errors.orderIndex}
              helpText="Counting the first order as 1 — e.g. 2 ships the gift with the customer's second order."
            />
          ) : null}
          {trigger === "DAYS_SUBSCRIBED" ? (
            <TextField
              label="Days subscribed"
              autoComplete="off"
              type="number"
              min={1}
              max={2000}
              value={daysSubscribed}
              onChange={setDaysSubscribed}
              error={errors.daysSubscribed}
              helpText="e.g. 365 for a one-year anniversary gift."
            />
          ) : null}
          <GiftVariantPicker
            currencyCode={currencyCode}
            selectedId={variantId}
            selectedLabel={variantTitle}
            error={errors.variantId}
            onSelect={(id, label) => {
              setVariantId(id);
              setVariantTitle(label);
            }}
            onClear={() => {
              setVariantId(null);
              setVariantTitle(null);
            }}
          />
          <TextField
            label="Unit cost (COGS)"
            autoComplete="off"
            type="number"
            min={0}
            step={0.01}
            value={unitCost}
            onChange={setUnitCost}
            prefix={currencyCode}
            error={errors.unitCost ?? errors.unitCostCents}
            helpText="What the gift costs you per unit — feeds lifetime gross profit math."
          />
          <Checkbox
            label="Announce in advance"
            checked={announce}
            onChange={setAnnounce}
            helpText='Sends a "stay subscribed and get X" email before the qualifying cycle — turns the gift into a retention hook instead of a silent cost.'
          />
          <Checkbox label="Rule is active" checked={active} onChange={setActive} />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

function grantBadgeTone(
  status: string,
): "success" | "critical" | "attention" | "info" | "warning" {
  switch (status) {
    case "SHIPPED":
      return "success";
    case "ADDED":
      return "info";
    case "SCHEDULED":
      return "attention";
    case "REMOVED":
      return "warning";
    default:
      return "critical";
  }
}

export default function GiftsPage() {
  const { currencyCode, rules, grants, lifecycle } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const navigation = useNavigation();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<RulePrefill | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RuleView | null>(null);

  const editingRule = rules.find((r) => r.id === editingRuleId) ?? null;

  useEffect(() => {
    if (!actionData) return;
    if (actionData.toast) {
      shopify.toast.show(actionData.toast, { isError: !actionData.ok });
    }
    if (actionData.ok && actionData.intent === "save-rule") {
      setModalOpen(false);
      setEditingRuleId(null);
      setPrefill(null);
    }
    if (actionData.ok && actionData.intent === "delete-rule") {
      setDeleteTarget(null);
    }
  }, [actionData, shopify]);

  const busy = navigation.state !== "idle";
  const navIntent = navigation.formData?.get("intent");

  const ruleErrors =
    actionData && actionData.intent === "save-rule" && !actionData.ok
      ? (actionData.errors ?? {})
      : {};

  const builtIns: Array<{
    key: string;
    title: string;
    description: string;
    prefill: RulePrefill;
    exists: boolean;
  }> = [
    {
      key: "cycle2",
      title: "Cycle-2 surprise gift",
      description:
        "An unannounced extra in the second order — lands exactly at peak early churn.",
      prefill: {
        name: "Cycle-2 surprise gift",
        trigger: "ORDER_INDEX",
        orderIndex: 2,
        daysSubscribed: null,
      },
      exists: rules.some(
        (r) => r.trigger === "ORDER_INDEX" && r.orderIndex === 2,
      ),
    },
    {
      key: "milestone",
      title: `Order-${lifecycle.milestoneGiftCycle} milestone gift`,
      description:
        "An announced milestone reward — gives mid-life subscribers a reason to stay through the boring middle.",
      prefill: {
        name: `Order-${lifecycle.milestoneGiftCycle} milestone gift`,
        trigger: "ORDER_INDEX",
        orderIndex: lifecycle.milestoneGiftCycle,
        daysSubscribed: null,
      },
      exists: rules.some(
        (r) =>
          r.trigger === "ORDER_INDEX" &&
          r.orderIndex === lifecycle.milestoneGiftCycle,
      ),
    },
    {
      key: "anniversary",
      title: `${lifecycle.anniversaryGiftDays}-day anniversary gift`,
      description:
        "Celebrates the subscription anniversary — your highest-LTV customers get the thank-you they deserve.",
      prefill: {
        name: "Anniversary gift",
        trigger: "DAYS_SUBSCRIBED",
        orderIndex: null,
        daysSubscribed: lifecycle.anniversaryGiftDays,
      },
      exists: rules.some(
        (r) =>
          r.trigger === "DAYS_SUBSCRIBED" &&
          r.daysSubscribed === lifecycle.anniversaryGiftDays,
      ),
    },
  ];

  const ruleRows = rules.map((rule) => [
    <Text as="span" key={`${rule.id}-name`} fontWeight="medium">
      {rule.name}
    </Text>,
    triggerHuman(rule),
    rule.variantTitle ?? rule.variantId,
    formatMoney(rule.unitCostCents, currencyCode),
    rule.announceInAdvance ? "Announced" : "Surprise",
    <Checkbox
      key={`${rule.id}-active`}
      label="Active"
      labelHidden
      checked={rule.active}
      onChange={(checked) =>
        submit(
          { intent: "toggle-rule", ruleId: rule.id, active: String(checked) },
          { method: "post" },
        )
      }
    />,
    <InlineStack key={`${rule.id}-actions`} gap="200" wrap={false}>
      <Button
        size="slim"
        onClick={() => {
          setEditingRuleId(rule.id);
          setPrefill(null);
          setModalOpen(true);
        }}
      >
        Edit
      </Button>
      <Button size="slim" tone="critical" onClick={() => setDeleteTarget(rule)}>
        Delete
      </Button>
    </InlineStack>,
  ]);

  const grantRows = grants.map((grant) => [
    grant.email,
    grant.ruleName ?? "—",
    `Cycle ${grant.cycleIndex}`,
    <Badge key={grant.id} tone={grantBadgeTone(grant.status)}>
      {grant.status}
    </Badge>,
    grant.createdAt,
  ]);

  return (
    <Page
      title="Gift rules"
      subtitle="Scheduled gifts are the cheapest retention lever — a few pounds of COGS against a whole saved cycle."
      primaryAction={{
        content: "Create gift rule",
        onAction: () => {
          setEditingRuleId(null);
          setPrefill(null);
          setModalOpen(true);
        },
      }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner title="Recommended lifecycle gifts" tone="info">
              <BlockStack gap="200">
                <Text as="p" variant="bodySm">
                  The lifecycle engine expects these three moments (timings come
                  from Settings → Lifecycle). Create the matching rule and pick
                  a variant:
                </Text>
                {builtIns.map((item) => (
                  <InlineStack
                    key={item.key}
                    gap="300"
                    blockAlign="center"
                    wrap
                  >
                    {item.exists ? (
                      <Badge tone="success">Configured</Badge>
                    ) : (
                      <Button
                        size="slim"
                        onClick={() => {
                          setEditingRuleId(null);
                          setPrefill(item.prefill);
                          setModalOpen(true);
                        }}
                      >
                        Create this rule
                      </Button>
                    )}
                    <Text as="span" fontWeight="medium">
                      {item.title}
                    </Text>
                    <Text as="span" tone="subdued" variant="bodySm">
                      {item.description}
                    </Text>
                  </InlineStack>
                ))}
              </BlockStack>
            </Banner>

            <Card>
              {rules.length === 0 ? (
                <EmptyState
                  heading="No gift rules yet"
                  action={{
                    content: "Create gift rule",
                    onAction: () => {
                      setEditingRuleId(null);
                      setPrefill(null);
                      setModalOpen(true);
                    },
                  }}
                  image=""
                >
                  <p>
                    Gift rules automatically add a free product to qualifying
                    renewal orders. Start with the three recommended lifecycle
                    gifts above.
                  </p>
                </EmptyState>
              ) : (
                <DataTable
                  columnContentTypes={[
                    "text",
                    "text",
                    "text",
                    "text",
                    "text",
                    "text",
                    "text",
                  ]}
                  headings={[
                    "Rule",
                    "Trigger",
                    "Gift",
                    "COGS",
                    "Announce",
                    "Active",
                    "Actions",
                  ]}
                  rows={ruleRows}
                />
              )}
            </Card>

            <Card>
              <BlockStack gap="300">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Recent gift grants
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    What the gift engine actually scheduled and shipped
                    (read-only, latest 25).
                  </Text>
                </BlockStack>
                <Divider />
                {grants.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No gifts granted yet.
                  </Text>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text", "text"]}
                    headings={["Subscriber", "Rule", "Cycle", "Status", "Date"]}
                    rows={grantRows}
                  />
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      {modalOpen ? (
        <RuleFormModal
          key={editingRule?.id ?? prefill?.name ?? "new"}
          rule={editingRule}
          prefill={prefill}
          open={modalOpen}
          currencyCode={currencyCode}
          errors={ruleErrors}
          saving={busy && navIntent === "save-rule"}
          onClose={() => {
            setModalOpen(false);
            setEditingRuleId(null);
            setPrefill(null);
          }}
          onSave={(fd) => submit(fd, { method: "post" })}
        />
      ) : null}

      <Modal
        open={deleteTarget != null}
        onClose={() => setDeleteTarget(null)}
        title={deleteTarget ? `Delete "${deleteTarget.name}"?` : "Delete rule"}
        primaryAction={{
          content: "Delete rule",
          destructive: true,
          loading: busy && navIntent === "delete-rule",
          onAction: () => {
            if (deleteTarget) {
              submit(
                { intent: "delete-rule", ruleId: deleteTarget.id },
                { method: "post" },
              );
            }
          },
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setDeleteTarget(null) },
        ]}
      >
        <Modal.Section>
          <Text as="p">
            Future gifts from this rule stop being scheduled. Already-granted
            gifts are kept for the audit trail and are not removed from upcoming
            orders.
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
