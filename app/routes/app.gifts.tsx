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
import { getSetting, setSetting } from "~/lib/settings/settings.server";
import { settingsSchemas, type SettingsValue } from "~/lib/settings/registry.server";
import { SURVEY_QUESTIONS } from "~/lib/survey/shared";
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
  selection: string;
  repeatsAnnually: boolean;
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
    // DYNAMIC rules pick the gift per customer from the pool; variantId
    // stays required as the fallback (and the whole story for FIXED).
    selection: z.enum(["FIXED", "DYNAMIC"]),
    repeatsAnnually: z.boolean(),
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

  const [rules, grants, lifecycle, gifts] = await Promise.all([
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
    getSetting(shop.id, "gifts"),
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
    selection: rule.selection,
    repeatsAnnually: rule.repeatsAnnually,
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
      milestoneLadder: lifecycle.milestoneLadder,
    },
    gifts,
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
      selection:
        String(formData.get("selection") ?? "FIXED") === "DYNAMIC"
          ? "DYNAMIC"
          : "FIXED",
      repeatsAnnually: formData.get("repeatsAnnually") === "true",
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
      selection: values.selection,
      // Anniversary repeats only make sense on DAYS_SUBSCRIBED rules.
      repeatsAnnually:
        values.trigger === "DAYS_SUBSCRIBED" ? values.repeatsAnnually : false,
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

  if (intent === "save-gifts-config") {
    // The pool/pairings editors post the whole gifts settings object as one
    // JSON payload; the registry schema is the validator (GID shapes, cost
    // bounds, record keys), so a malformed post can never corrupt the
    // stored value.
    let candidate: unknown;
    try {
      candidate = JSON.parse(String(formData.get("config") ?? ""));
    } catch {
      return json<ActionData>(
        { intent, ok: false, toast: "Invalid gift configuration payload" },
        { status: 422 },
      );
    }
    const parsed = settingsSchemas.gifts.safeParse(candidate);
    if (!parsed.success) {
      return json<ActionData>(
        {
          intent,
          ok: false,
          toast: `Gift configuration rejected: ${parsed.error.issues[0]?.message ?? "invalid"}`,
        },
        { status: 422 },
      );
    }
    const previous = await getSetting(shop.id, "gifts");
    await setSetting(shop.id, "gifts", parsed.data, actor);
    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "ADMIN",
      actor,
      payload: {
        action: "gifts_config_updated",
        poolSize: parsed.data.pool.length,
        pairingProducts: Object.keys(parsed.data.pairings).length,
        surveyPairingKeys: Object.keys(parsed.data.surveyPairings).length,
        maxGiftsPerCycle: parsed.data.maxGiftsPerCycle,
        previousPoolSize: previous.pool.length,
      },
    });
    return json<ActionData>({ intent, ok: true, toast: "Gift pool saved" });
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
  const [selection, setSelection] = useState<string>(rule?.selection ?? "FIXED");
  const [repeatsAnnually, setRepeatsAnnually] = useState(
    rule?.repeatsAnnually ?? false,
  );

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
    fd.set("selection", selection);
    fd.set("repeatsAnnually", String(repeatsAnnually));
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
          {trigger === "DAYS_SUBSCRIBED" ? (
            <Checkbox
              label="Repeat every anniversary"
              checked={repeatsAnnually}
              onChange={setRepeatsAnnually}
              helpText="Fires at every multiple (365, 730, 1095…) instead of once — long-tenure subscribers always have a next anniversary."
            />
          ) : null}
          <Select
            label="Gift selection"
            options={[
              { label: "Fixed — always this product", value: "FIXED" },
              {
                label: "Dynamic — pick the best product per customer",
                value: "DYNAMIC",
              },
            ]}
            value={selection}
            onChange={setSelection}
            helpText="Dynamic picks from the gift pool below: always something the customer doesn't already have, ranked by your pairings. The product picked here becomes the fallback."
          />
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

// ── Gift pool & pairings ─────────────────────────────────────────────────────

type GiftsConfig = SettingsValue<"gifts">;

/**
 * Ordered multi-pick over the pool: click an unselected gift to append it
 * (rank = click order, shown as a number), click a selected one to remove
 * it. Deliberately tiny — the pool is ~10 products.
 */
function RankedGiftPicker({
  pool,
  selected,
  onChange,
}: {
  pool: GiftsConfig["pool"];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <InlineStack gap="150" wrap>
      {pool.map((entry) => {
        const rank = selected.indexOf(entry.variantId);
        const label = entry.variantTitle ?? entry.variantId;
        return (
          <Button
            key={entry.variantId}
            size="slim"
            pressed={rank >= 0}
            onClick={() =>
              onChange(
                rank >= 0
                  ? selected.filter((v) => v !== entry.variantId)
                  : [...selected, entry.variantId],
              )
            }
          >
            {rank >= 0 ? `${rank + 1}. ${label}` : label}
          </Button>
        );
      })}
    </InlineStack>
  );
}

function GiftPoolCard({
  gifts,
  currencyCode,
  saving,
  onSave,
}: {
  gifts: GiftsConfig;
  currencyCode: string;
  saving: boolean;
  onSave: (next: GiftsConfig) => void;
}) {
  const [pool, setPool] = useState<GiftsConfig["pool"]>(gifts.pool);
  const [pairings, setPairings] = useState<Record<string, string[]>>(
    Object.fromEntries(
      Object.entries(gifts.pairings).map(([k, v]) => [k, [...v]]),
    ),
  );
  const [surveyPairings, setSurveyPairings] = useState<Record<string, string[]>>(
    Object.fromEntries(
      Object.entries(gifts.surveyPairings).map(([k, v]) => [k, [...v]]),
    ),
  );
  const [pairingProducts, setPairingProducts] = useState<
    Array<{ id: string; title: string }>
  >(
    Object.keys(gifts.pairings).map((id) => ({ id, title: id })),
  );
  const [costDrafts, setCostDrafts] = useState<Record<string, string>>(
    Object.fromEntries(
      gifts.pool.map((p) => [
        p.variantId,
        p.unitCostCents > 0 ? (p.unitCostCents / 100).toFixed(2) : "",
      ]),
    ),
  );

  const addPoolEntry = (variantId: string, label: string) => {
    if (pool.some((p) => p.variantId === variantId)) return;
    setPool([...pool, { variantId, variantTitle: label, unitCostCents: 0 }]);
  };
  const removePoolEntry = (variantId: string) => {
    setPool(pool.filter((p) => p.variantId !== variantId));
    setPairings(
      Object.fromEntries(
        Object.entries(pairings).map(([k, v]) => [
          k,
          v.filter((x) => x !== variantId),
        ]),
      ),
    );
    setSurveyPairings(
      Object.fromEntries(
        Object.entries(surveyPairings).map(([k, v]) => [
          k,
          v.filter((x) => x !== variantId),
        ]),
      ),
    );
  };

  const handleSave = () => {
    const nextPool = pool.map((p) => {
      const draft = (costDrafts[p.variantId] ?? "").trim();
      const cents = draft === "" ? 0 : centsFromDecimalString(draft);
      return {
        ...p,
        unitCostCents: Number.isNaN(cents) || cents < 0 ? 0 : cents,
      };
    });
    const clean = (rec: Record<string, string[]>): Record<string, string[]> =>
      Object.fromEntries(
        Object.entries(rec).filter(([, v]) => v.length > 0),
      );
    onSave({
      pool: nextPool,
      pairings: clean(pairings),
      surveyPairings: clean(surveyPairings),
      maxGiftsPerCycle: gifts.maxGiftsPerCycle,
    });
  };

  const motiveQuestion = SURVEY_QUESTIONS.find((q) => q.key === "motive");

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            Gift pool — dynamic picking
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Products the picker may give as gifts. Dynamic rules, the
            cancel-flow gift save, the win-back perk, milestone-ladder rungs
            and the day-90 reward all choose from this pool — always a product
            the customer doesn't already have. Cost left at 0 uses Shopify's
            cost per item.
          </Text>
        </BlockStack>
        <Divider />
        {pool.length === 0 ? (
          <Text as="p" tone="subdued">
            The pool is empty — dynamic picks fall back to each rule's fixed
            product, and pool-dependent gifts (cancel save, day-90 reward,
            ladder) quietly stand down.
          </Text>
        ) : (
          <BlockStack gap="200">
            {pool.map((entry) => (
              <InlineStack key={entry.variantId} gap="300" blockAlign="center" wrap>
                <Box minWidth="240px">
                  <Text as="span" fontWeight="medium">
                    {entry.variantTitle ?? entry.variantId}
                  </Text>
                </Box>
                <Box maxWidth="160px">
                  <TextField
                    label="COGS"
                    labelHidden
                    autoComplete="off"
                    type="number"
                    min={0}
                    step={0.01}
                    prefix={currencyCode}
                    placeholder="Shopify cost"
                    value={costDrafts[entry.variantId] ?? ""}
                    onChange={(v) =>
                      setCostDrafts({ ...costDrafts, [entry.variantId]: v })
                    }
                  />
                </Box>
                <Button
                  size="slim"
                  tone="critical"
                  variant="tertiary"
                  onClick={() => removePoolEntry(entry.variantId)}
                >
                  Remove
                </Button>
              </InlineStack>
            ))}
          </BlockStack>
        )}
        <GiftVariantPicker
          currencyCode={currencyCode}
          selectedId={null}
          selectedLabel={null}
          onSelect={addPoolEntry}
          onClear={() => {}}
        />
        <Divider />
        <BlockStack gap="200">
          <BlockStack gap="100">
            <Text as="h3" variant="headingSm">
              Pairings — what goes best with what they already get
            </Text>
            <Text as="p" tone="subdued" variant="bodySm">
              For a subscribed product, rank the gifts that pair with it (1 =
              best). The strongest ranking signal the picker has.
            </Text>
          </BlockStack>
          {pairingProducts.map((product) => (
            <BlockStack gap="100" key={product.id}>
              <InlineStack gap="200" blockAlign="center">
                <Text as="span" fontWeight="medium">
                  {product.title === product.id
                    ? `Product ${product.id.split("/").pop()}`
                    : product.title}
                </Text>
                <Button
                  size="micro"
                  tone="critical"
                  variant="tertiary"
                  onClick={() => {
                    setPairingProducts(
                      pairingProducts.filter((x) => x.id !== product.id),
                    );
                    const next = { ...pairings };
                    delete next[product.id];
                    setPairings(next);
                  }}
                >
                  Remove
                </Button>
              </InlineStack>
              <RankedGiftPicker
                pool={pool}
                selected={pairings[product.id] ?? []}
                onChange={(next) =>
                  setPairings({ ...pairings, [product.id]: next })
                }
              />
            </BlockStack>
          ))}
          <PairingProductAdder
            existing={pairingProducts.map((x) => x.id)}
            onAdd={(id, title) => {
              setPairingProducts([...pairingProducts, { id, title }]);
              if (!pairings[id]) setPairings({ ...pairings, [id]: [] });
            }}
          />
        </BlockStack>
        <Divider />
        {motiveQuestion ? (
          <BlockStack gap="200">
            <BlockStack gap="100">
              <Text as="h3" variant="headingSm">
                Survey tiebreaker — match gifts to what customers came for
              </Text>
              <Text as="p" tone="subdued" variant="bodySm">
                When pairings tie, the post-purchase survey's "what brings you
                here" answer breaks it. Optional.
              </Text>
            </BlockStack>
            {motiveQuestion.options.map((option) => (
              <BlockStack gap="100" key={option}>
                <Text as="span" fontWeight="medium">
                  {option.replaceAll("_", " ")}
                </Text>
                <RankedGiftPicker
                  pool={pool}
                  selected={surveyPairings[`motive:${option}`] ?? []}
                  onChange={(next) =>
                    setSurveyPairings({
                      ...surveyPairings,
                      [`motive:${option}`]: next,
                    })
                  }
                />
              </BlockStack>
            ))}
          </BlockStack>
        ) : null}
        <InlineStack align="end">
          <Button variant="primary" loading={saving} onClick={handleSave}>
            Save gift pool
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

/** Product (not variant) search for pairing keys. */
function PairingProductAdder({
  existing,
  onAdd,
}: {
  existing: string[];
  onAdd: (productId: string, title: string) => void;
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

  const results = (fetcher.data?.searchResults ?? []).filter(
    (product) => !existing.includes(product.id),
  );

  return (
    <BlockStack gap="200">
      <TextField
        label="Add a subscribed product"
        autoComplete="off"
        value={query}
        onChange={setQuery}
        placeholder="Search your products…"
        loading={fetcher.state !== "idle"}
      />
      {results.length > 0 && query.trim().length >= 2 ? (
        <Box borderColor="border" borderWidth="025" borderRadius="200" padding="150">
          <BlockStack gap="100">
            {results.map((product) => (
              <Button
                key={product.id}
                variant="tertiary"
                textAlign="left"
                fullWidth
                onClick={() => {
                  onAdd(product.id, product.title);
                  setQuery("");
                }}
              >
                {product.title}
              </Button>
            ))}
          </BlockStack>
        </Box>
      ) : null}
    </BlockStack>
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
  const { currencyCode, rules, grants, lifecycle, gifts } =
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
    rule.selection === "DYNAMIC"
      ? `Dynamic (fallback: ${rule.variantTitle ?? rule.variantId})`
      : (rule.variantTitle ?? rule.variantId),
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

            <GiftPoolCard
              key={JSON.stringify(gifts)}
              gifts={gifts}
              currencyCode={currencyCode}
              saving={busy && navIntent === "save-gifts-config"}
              onSave={(next) =>
                submit(
                  {
                    intent: "save-gifts-config",
                    config: JSON.stringify(next),
                  },
                  { method: "post" },
                )
              }
            />
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
