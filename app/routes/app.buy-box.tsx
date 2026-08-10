import { useEffect, useMemo, useState } from "react";
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
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  Checkbox,
  ChoiceList,
  DataTable,
  Divider,
  InlineGrid,
  InlineStack,
  Layout,
  Modal,
  Page,
  RangeSlider,
  Select,
  Tabs,
  Text,
  TextField,
} from "@shopify/polaris";
import { ZodError } from "zod";
import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { logEvent } from "~/lib/events/log.server";
import { getLaunchState } from "~/lib/launch/launch.server";
import { getDesignPerformance } from "~/lib/analytics/queries.server";
import {
  getDraftOrPublished,
  listRevisions,
  publishRevision,
  restoreRevision,
  saveDraftRevision,
} from "~/lib/widget/design.server";
import {
  listMarkets,
  type AdminClient,
  type ShopifyMarket,
} from "~/lib/graphql/index.server";
import {
  PRESET_KEYS,
  PRESET_META,
  PRICE_SELECTOR_MAX_LENGTH,
  widgetDesignConfigSchema,
  type PresetKey,
  type PresetMeta,
  type WidgetDesignConfig,
  type WidgetDesignTextOverride,
} from "~/lib/widget/presets";
import { BuyBoxPreview } from "~/components/buybox-preview";

/**
 * Admin — Buy box designer.
 *
 * Configures the PDP subscription buy box: eight design presets with deep
 * customization (layout / per-locale text / style / behavior / app-embed
 * placement), per-Shopify-Market preset selection (v1.6.0 — config.markets,
 * keyed by market handle; everything but the preset inherits the main
 * design), a live preview with a market-preview select, draft + publish
 * with revision history (instant restore), and per-design take-rate
 * attribution. Publishing mirrors the config to the cellexia.buybox_design
 * shop metafield; a shop with no published revision keeps rendering exactly
 * as v1.0.0 did.
 */

// ── Shared view types ────────────────────────────────────────────────────────

interface RevisionView {
  id: string;
  preset: string;
  createdAt: string;
  createdBy: string | null;
  publishedAt: string | null;
  /** Null when the stored config no longer validates (cannot be loaded). */
  config: WidgetDesignConfig | null;
}

interface ActionData {
  intent: string;
  ok: boolean;
  toast?: string;
}

function actorFromSession(session: {
  shop: string;
  onlineAccessInfo?: { associated_user?: { email?: string | null } } | null;
}): string {
  return session.onlineAccessInfo?.associated_user?.email ?? `admin@${session.shop}`;
}

// ── Loader ───────────────────────────────────────────────────────────────────

/**
 * Markets for the per-market design card. A failed Admin API read must not
 * take the whole designer down — the card degrades to its empty state and
 * everything else keeps working (any stale config.markets entries stay
 * editable through their own rows).
 */
async function listMarketsSafe(admin: AdminClient): Promise<ShopifyMarket[]> {
  try {
    return await listMarkets(admin);
  } catch (err) {
    console.error("[widget] markets fetch failed, designer degrades", err);
    return [];
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }

  const [draftOrPublished, revisions, performance, launch, markets] =
    await Promise.all([
      getDraftOrPublished(shop.id),
      listRevisions(shop.id),
      getDesignPerformance(shop.id, 30),
      getLaunchState(shop.id),
      listMarketsSafe(admin),
    ]);

  const revisionViews: RevisionView[] = revisions.map((r) => {
    const parsed = widgetDesignConfigSchema.safeParse(r.config);
    return {
      id: r.id,
      preset: r.preset,
      createdAt: r.createdAt.toISOString(),
      createdBy: r.createdBy,
      publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
      config: parsed.success ? parsed.data : null,
    };
  });

  return json({
    savedConfig: draftOrPublished.config,
    isDraft: draftOrPublished.isDraft,
    launchMode: launch.mode,
    revisions: revisionViews,
    performance,
    markets,
  });
};

// ── Action ───────────────────────────────────────────────────────────────────

function zodMessage(err: ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "Invalid design config";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

function parseConfigField(formData: FormData): unknown {
  return JSON.parse(String(formData.get("config") ?? ""));
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

  if (intent === "save-draft") {
    try {
      const revision = await saveDraftRevision(
        shop.id,
        parseConfigField(formData),
        actor,
      );
      await logEvent({
        shopId: shop.id,
        type: "admin.action",
        source: "ADMIN",
        actor,
        payload: {
          action: "buybox_design_draft_saved",
          preset: revision.preset,
          revisionId: revision.id,
        },
      });
      return json<ActionData>({
        intent,
        ok: true,
        toast: "Draft saved — publish it when you're ready",
      });
    } catch (err) {
      const message =
        err instanceof ZodError
          ? zodMessage(err)
          : err instanceof Error
            ? err.message
            : String(err);
      return json<ActionData>(
        { intent, ok: false, toast: `Draft not saved: ${message}` },
        { status: 422 },
      );
    }
  }

  if (intent === "publish") {
    try {
      const draft = await saveDraftRevision(
        shop.id,
        parseConfigField(formData),
        actor,
      );
      // publishRevision re-validates, mirrors the config to the shop
      // metafield and logs its own admin.action event.
      await publishRevision(shop.id, draft.id, actor);
      const launch = await getLaunchState(shop.id);
      return json<ActionData>({
        intent,
        ok: true,
        toast:
          launch.mode === "LIVE"
            ? "Published — the new design is live on your storefront"
            : "Published — it stays invisible until you go live (Setup mode)",
      });
    } catch (err) {
      const message =
        err instanceof ZodError
          ? zodMessage(err)
          : err instanceof Error
            ? err.message
            : String(err);
      return json<ActionData>(
        { intent, ok: false, toast: `Publish failed: ${message}` },
        { status: 422 },
      );
    }
  }

  if (intent === "restore") {
    const revisionId = String(formData.get("revisionId") ?? "");
    try {
      // restoreRevision copies into a NEW revision and publishes it (which
      // logs the publish event); log the restore intent on top for the audit
      // trail.
      const restored = await restoreRevision(shop.id, revisionId, actor);
      await logEvent({
        shopId: shop.id,
        type: "admin.action",
        source: "ADMIN",
        actor,
        payload: {
          action: "buybox_design_restored",
          sourceRevisionId: revisionId,
          revisionId: restored.id,
          preset: restored.preset,
        },
      });
      const launch = await getLaunchState(shop.id);
      return json<ActionData>({
        intent,
        ok: true,
        toast:
          launch.mode === "LIVE"
            ? "Design restored — it is live on your storefront"
            : "Design restored and published (invisible until you go live)",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json<ActionData>(
        { intent, ok: false, toast: `Restore failed: ${message}` },
        { status: 422 },
      );
    }
  }

  return json<ActionData>(
    { intent, ok: false, toast: "Unknown action" },
    { status: 400 },
  );
};

// ── Editor constants ─────────────────────────────────────────────────────────

/** The 22 storefront locales the extension ships translations for. */
const SUPPORTED_LOCALES: { value: string; label: string }[] = [
  { value: "en", label: "English (en)" },
  { value: "ar", label: "Arabic (ar)" },
  { value: "cs", label: "Czech (cs)" },
  { value: "da", label: "Danish (da)" },
  { value: "de", label: "German (de)" },
  { value: "el", label: "Greek (el)" },
  { value: "es", label: "Spanish (es)" },
  { value: "fi", label: "Finnish (fi)" },
  { value: "fr", label: "French (fr)" },
  { value: "hu", label: "Hungarian (hu)" },
  { value: "it", label: "Italian (it)" },
  { value: "ja", label: "Japanese (ja)" },
  { value: "ko", label: "Korean (ko)" },
  { value: "nb", label: "Norwegian (nb)" },
  { value: "nl", label: "Dutch (nl)" },
  { value: "pl", label: "Polish (pl)" },
  { value: "pt-BR", label: "Portuguese — Brazil (pt-BR)" },
  { value: "pt-PT", label: "Portuguese — Portugal (pt-PT)" },
  { value: "ro", label: "Romanian (ro)" },
  { value: "sv", label: "Swedish (sv)" },
  { value: "tr", label: "Turkish (tr)" },
  { value: "zh-CN", label: "Chinese — Simplified (zh-CN)" },
];

type TextKey = Exclude<keyof WidgetDesignTextOverride, "benefits">;

const TEXT_FIELDS: { key: TextKey; label: string; templated: boolean }[] = [
  { key: "heading", label: "Heading", templated: true },
  { key: "subheading", label: "Subheading", templated: true },
  { key: "subscribeLabel", label: "Subscribe option label", templated: true },
  { key: "oneTimeLabel", label: "One-time option label", templated: false },
  { key: "badge", label: "Badge", templated: false },
  { key: "savingsTemplate", label: "Savings label", templated: true },
  { key: "reassurance", label: "Reassurance line", templated: true },
  { key: "frequencyLabel", label: "Frequency label", templated: false },
  { key: "firstOrderLine", label: "First-order note", templated: true },
  {
    key: "oneTimeLinkLabel",
    label: "One-time link label (Value stack & Subscription max / ultra max)",
    templated: true,
  },
];

const DEFAULT_BENEFITS = [
  "Extra welcome saving on your first order",
  "Ongoing savings on every delivery",
  "A complimentary gift as your ritual grows",
  "Skip, pause or cancel anytime",
];

/** English defaults shown as "inherited" placeholders in the Text tab. */
function enDefaultFor(key: TextKey, preset: PresetKey): string {
  switch (key) {
    case "heading":
      // subscription_max family: no "choose your option" framing — empty heading.
      return preset === "subscription_max" || preset === "subscription_ultra_max"
        ? ""
        : "Choose your ritual";
    case "subheading":
      return "";
    case "subscribeLabel":
      return preset === "toggle" || preset === "inline"
        ? "Subscribe & save {percent}"
        : "Subscribe & Save";
    case "oneTimeLabel":
      return "One-time purchase";
    case "badge":
      return "Most popular";
    case "savingsTemplate":
      return "Save {percent}";
    case "reassurance":
      return "Skip, pause or cancel anytime.";
    case "frequencyLabel":
      return preset === "planner" ? "How often do you need it?" : "Delivery every";
    case "firstOrderLine":
      return "First order";
    case "oneTimeLinkLabel":
      return "or buy once for {amount}";
  }
}

/**
 * Layout knobs a preset's archetype requires when switching to it. This IS
 * the per-preset defaults mechanism: the patch is applied to the draft when
 * the merchant SELECTS the preset, the knobs stay individually editable
 * afterwards, and the published config carries the explicit values.
 *
 * subscription_max is quiet by design — no badge, no frequency selector
 * (the plan's default cadence applies; both re-enableable). A per-market
 * subscription_max override picked in the Markets card inherits the MAIN
 * design's layout instead (only the preset varies per market); the Liquid
 * additionally defaults both knobs off at render time when the config
 * cannot speak for them.
 *
 * subscription_ultra_max (v1.11.0) is quieter still: savings and
 * reassurance also start off (each re-enableable) — the card must read as
 * the plain, normal way of buying. The Liquid mirrors the same defaults at
 * render time, and ALSO preselects the subscription for this preset unless
 * the config explicitly says one_time — deliberately enforced at render
 * time rather than written into the draft here, so browsing through the
 * preset gallery can never leave `behavior.preselect` flipped on a design
 * that ends up publishing a different preset.
 */
const PRESET_LAYOUT_PATCH: Partial<
  Record<PresetKey, Partial<WidgetDesignConfig["layout"]>>
> = {
  value_stack: { showBenefits: true },
  planner: { frequencyStyle: "chips" },
  subscription_max: { showBadge: false, showFrequency: false },
  subscription_ultra_max: {
    showBadge: false,
    showFrequency: false,
    showSavings: false,
    showReassurance: false,
  },
};

function applyPresetDefaults(
  config: WidgetDesignConfig,
  preset: PresetKey,
): WidgetDesignConfig {
  const layout = { ...config.layout, ...(PRESET_LAYOUT_PATCH[preset] ?? {}) };
  if (preset === "value_stack" && layout.benefitCount < 1) {
    layout.benefitCount = 4;
  }
  return { ...config, preset, layout };
}

/** Drop empty text overrides / blank benefit rows before submitting. */
function cleanConfig(config: WidgetDesignConfig): WidgetDesignConfig {
  const text: WidgetDesignConfig["text"] = {};
  for (const [locale, entry] of Object.entries(config.text)) {
    const cleaned: WidgetDesignTextOverride = { ...entry };
    if (cleaned.benefits) {
      const benefits = cleaned.benefits
        .map((b) => b.trim())
        .filter((b) => b !== "");
      if (benefits.length > 0) cleaned.benefits = benefits;
      else delete cleaned.benefits;
    }
    for (const key of Object.keys(cleaned) as (keyof WidgetDesignTextOverride)[]) {
      const value = cleaned[key];
      if (typeof value === "string" && value.trim() === "") delete cleaned[key];
    }
    if (Object.keys(cleaned).length > 0) text[locale] = cleaned;
  }
  return { ...config, text };
}

function presetName(preset: string): string {
  return (
    (PRESET_META as Record<string, PresetMeta | undefined>)[preset]?.name ??
    preset
  );
}

function riskBadge(risk: PresetMeta["conversionRisk"]) {
  if (risk === "minimal") return <Badge tone="success">Minimal conversion risk</Badge>;
  if (risk === "low") return <Badge tone="info">Low conversion risk</Badge>;
  return <Badge tone="attention">Medium conversion risk</Badge>;
}

function formatRevisionDate(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function toSixDigitHex(hex: string): string {
  const raw = hex.replace("#", "");
  if (raw.length === 3) {
    return `#${raw
      .split("")
      .map((c) => c + c)
      .join("")}`;
  }
  return `#${raw}`;
}

const PAGE_CSS = `
.cx-color-swatch {
  position: relative;
  display: inline-block;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.25);
  cursor: pointer;
  flex: 0 0 auto;
}
.cx-color-swatch input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}
.cx-css-mono textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
`;

// ── Small controls ───────────────────────────────────────────────────────────

function ColorField({
  label,
  value,
  fallbackHex,
  inheritable,
  helpText,
  onChange,
}: {
  label: string;
  value: string;
  /** Swatch color while the value is empty ("inherit") or invalid. */
  fallbackHex: string;
  inheritable?: boolean;
  helpText?: string;
  onChange: (next: string) => void;
}) {
  const valid = HEX_RE.test(value);
  const swatchHex = valid ? value : fallbackHex;
  return (
    <InlineStack gap="200" blockAlign="start" wrap={false}>
      <Box paddingBlockStart="600">
        <label
          className="cx-color-swatch"
          style={{ background: swatchHex }}
        >
          <input
            type="color"
            value={toSixDigitHex(swatchHex)}
            onChange={(e) => onChange(e.currentTarget.value)}
            aria-label={`${label} color picker`}
          />
        </label>
      </Box>
      <Box width="100%">
        <TextField
          label={label}
          autoComplete="off"
          value={value}
          onChange={onChange}
          placeholder={inheritable ? "Inherit theme default" : undefined}
          error={
            value !== "" && !valid ? "Use a hex color like #1d1d1b" : undefined
          }
          helpText={helpText}
          labelAction={
            inheritable && value !== ""
              ? { content: "Reset to inherit", onAction: () => onChange("") }
              : undefined
          }
        />
      </Box>
    </InlineStack>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function BuyBoxDesignerPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const navigation = useNavigation();

  const savedConfig = data.savedConfig as WidgetDesignConfig;
  const revisions = data.revisions as RevisionView[];
  const markets = data.markets as ShopifyMarket[];
  const { performance, launchMode, isDraft } = data;

  // Editor state: the draft config, reset whenever the server-side config
  // actually changes (after save/publish/restore).
  const [draft, setDraft] = useState<WidgetDesignConfig>(savedConfig);
  const savedKey = useMemo(() => JSON.stringify(savedConfig), [savedConfig]);
  const [baseline, setBaseline] = useState(savedKey);
  useEffect(() => {
    if (savedKey !== baseline) {
      setBaseline(savedKey);
      setDraft(savedConfig);
    }
  }, [savedKey, baseline, savedConfig]);
  const dirty = useMemo(
    () => JSON.stringify(draft) !== baseline,
    [draft, baseline],
  );

  const [tab, setTab] = useState(0);
  const [textLocale, setTextLocale] = useState("en");
  const [previewState, setPreviewState] = useState<"subscription" | "one_time">(
    "subscription",
  );
  const [previewWidth, setPreviewWidth] = useState<"desktop" | "mobile">(
    "desktop",
  );
  /** "" = the default design; a market handle previews that market. */
  const [previewMarket, setPreviewMarket] = useState("");

  const [publishOpen, setPublishOpen] = useState(false);
  const [pendingPreset, setPendingPreset] = useState<PresetKey | null>(null);
  const [loadTarget, setLoadTarget] = useState<RevisionView | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<RevisionView | null>(null);

  useEffect(() => {
    if (!actionData) return;
    if (actionData.toast) {
      shopify.toast.show(actionData.toast, { isError: !actionData.ok });
    }
    if (actionData.ok && actionData.intent === "publish") setPublishOpen(false);
    if (actionData.ok && actionData.intent === "restore") setRestoreTarget(null);
  }, [actionData, shopify]);

  const navIntent = navigation.formData?.get("intent");
  const busy = navigation.state !== "idle";

  // ── Draft updaters ─────────────────────────────────────────────────────────

  const setLayout = <K extends keyof WidgetDesignConfig["layout"]>(
    key: K,
    value: WidgetDesignConfig["layout"][K],
  ) => setDraft((d) => ({ ...d, layout: { ...d.layout, [key]: value } }));

  const setStyle = <K extends keyof WidgetDesignConfig["style"]>(
    key: K,
    value: WidgetDesignConfig["style"][K],
  ) => setDraft((d) => ({ ...d, style: { ...d.style, [key]: value } }));

  const setBehavior = <K extends keyof WidgetDesignConfig["behavior"]>(
    key: K,
    value: WidgetDesignConfig["behavior"][K],
  ) => setDraft((d) => ({ ...d, behavior: { ...d.behavior, [key]: value } }));

  const setPlacement = <K extends keyof WidgetDesignConfig["placement"]>(
    key: K,
    value: WidgetDesignConfig["placement"][K],
  ) =>
    setDraft((d) => ({ ...d, placement: { ...d.placement, [key]: value } }));

  const setThemeSync = <K extends keyof WidgetDesignConfig["themeSync"]>(
    key: K,
    value: WidgetDesignConfig["themeSync"][K],
  ) =>
    setDraft((d) => ({ ...d, themeSync: { ...d.themeSync, [key]: value } }));

  /** "" removes the entry — the market falls back to the main design. */
  const setMarketPreset = (handle: string, preset: PresetKey | "") =>
    setDraft((d) => {
      const nextMarkets = { ...d.markets };
      if (preset === "") delete nextMarkets[handle];
      else nextMarkets[handle] = { preset };
      return { ...d, markets: nextMarkets };
    });

  const setTextField = (key: TextKey, value: string) =>
    setDraft((d) => {
      const entry: WidgetDesignTextOverride = { ...(d.text[textLocale] ?? {}) };
      if (value === "") delete entry[key];
      else entry[key] = value;
      const text = { ...d.text };
      if (Object.keys(entry).length === 0) delete text[textLocale];
      else text[textLocale] = entry;
      return { ...d, text };
    });

  const setBenefits = (benefits: string[]) =>
    setDraft((d) => {
      const entry: WidgetDesignTextOverride = { ...(d.text[textLocale] ?? {}) };
      if (benefits.length === 0) delete entry.benefits;
      else entry.benefits = benefits;
      const text = { ...d.text };
      if (Object.keys(entry).length === 0) delete text[textLocale];
      else text[textLocale] = entry;
      return { ...d, text };
    });

  const selectPreset = (preset: PresetKey) => {
    if (preset === draft.preset) return;
    if (dirty) {
      setPendingPreset(preset);
      return;
    }
    setDraft((d) => applyPresetDefaults(d, preset));
  };

  // ── Submits ────────────────────────────────────────────────────────────────

  const submitConfig = (intent: "save-draft" | "publish") =>
    submit(
      { intent, config: JSON.stringify(cleanConfig(draft)) },
      { method: "post" },
    );

  // ── Text tab helpers ───────────────────────────────────────────────────────

  const localeEntry = draft.text[textLocale] ?? {};
  const inheritedPlaceholder = (key: TextKey): string => {
    if (textLocale !== "en") {
      const en = draft.text["en"]?.[key];
      if (typeof en === "string" && en.trim() !== "") return en;
    }
    return enDefaultFor(key, draft.preset) || "(empty — hidden)";
  };
  const localeBenefits = localeEntry.benefits ?? [];

  // ── Markets helpers ────────────────────────────────────────────────────────

  /** config.markets entries whose market no longer exists on the shop. */
  const staleMarketHandles = Object.keys(draft.markets).filter(
    (handle) => !markets.some((m) => m.handle === handle),
  );

  const marketPresetOptions = [
    { label: "Default (use main design)", value: "" },
    ...PRESET_KEYS.map((key) => ({ label: PRESET_META[key].name, value: key })),
  ];

  /**
   * The preset a market resolves to on the storefront — the client-side
   * mirror of the Liquid's `config.markets[localization.market.handle].preset
   * → config.preset` chain.
   */
  const resolveMarketPreset = (handle: string): PresetKey =>
    draft.markets[handle]?.preset ?? draft.preset;

  const previewPreset: PresetKey = previewMarket
    ? resolveMarketPreset(previewMarket)
    : draft.preset;

  // ── Render ─────────────────────────────────────────────────────────────────

  const editorTabs = [
    { id: "layout", content: "Layout" },
    { id: "text", content: "Text" },
    { id: "style", content: "Style" },
    { id: "behavior", content: "Behavior" },
  ];

  const performanceRows = performance.rows.map((row) => [
    presetName(row.designKey),
    String(row.subscriptionOrders),
    `${row.sharePct}%`,
  ]);

  return (
    <Page
      title="Buy box designer"
      subtitle="Eight conversion-tested presets with deep customization and per-market selection — preview everything, publish safely, restore instantly."
      primaryAction={{
        content: "Publish",
        onAction: () => setPublishOpen(true),
        disabled: busy,
      }}
      secondaryActions={[
        {
          content: "Save draft",
          onAction: () => submitConfig("save-draft"),
          disabled: busy || !dirty,
          loading: busy && navIntent === "save-draft",
        },
      ]}
    >
      <style dangerouslySetInnerHTML={{ __html: PAGE_CSS }} />
      <BlockStack gap="400">
        <InlineStack gap="200">
          {isDraft ? <Badge tone="attention">Unpublished draft</Badge> : null}
          {dirty ? <Badge tone="attention">Unsaved changes</Badge> : null}
          {launchMode === "SETUP" ? (
            <Badge tone="info">Setup mode — storefront stays dark</Badge>
          ) : null}
        </InlineStack>

        {/* ── Preset gallery ── */}
        <Card>
          <BlockStack gap="300">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">
                Design presets
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Each preset is a distinct conversion archetype. Your colors,
                text and layout customizations carry over when you switch.
              </Text>
            </BlockStack>
            <InlineGrid columns={{ xs: 1, sm: 2, lg: 3 }} gap="300">
              {PRESET_KEYS.map((key) => {
                const meta = PRESET_META[key];
                const isActive = draft.preset === key;
                return (
                  <div
                    key={key}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isActive}
                    onClick={() => selectPreset(key)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        selectPreset(key);
                      }
                    }}
                    style={{
                      border: isActive
                        ? "2px solid var(--p-color-border-emphasis, #005bd3)"
                        : "1px solid var(--p-color-border, #e3e3e3)",
                      borderRadius: 12,
                      padding: isActive ? 11 : 12,
                      cursor: "pointer",
                      background: "var(--p-color-bg-surface, #ffffff)",
                    }}
                  >
                    <BlockStack gap="200">
                      <BuyBoxPreview config={draft} preset={key} compact />
                      <InlineStack
                        align="space-between"
                        blockAlign="center"
                        gap="200"
                        wrap
                      >
                        <Text as="h3" variant="headingSm">
                          {meta.name}
                        </Text>
                        {riskBadge(meta.conversionRisk)}
                      </InlineStack>
                      <Text as="p" variant="bodySm">
                        {meta.tagline}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {meta.croRationale}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        <strong>Best for:</strong> {meta.bestFor}
                      </Text>
                    </BlockStack>
                  </div>
                );
              })}
            </InlineGrid>
          </BlockStack>
        </Card>

        {/* ── Markets (per-market preset) ── */}
        <Card>
          <BlockStack gap="300">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">
                Markets
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Choose a different preset per Shopify Market. Every market
                uses the main design above unless you pick one here — and
                only the preset changes per market: colors, text, layout and
                behavior are always shared with the main design. Saved and
                published with the rest of the design.
              </Text>
            </BlockStack>
            {markets.length === 0 && staleMarketHandles.length === 0 ? (
              <Text as="p" tone="subdued">
                No markets to configure — either your shop sells through a
                single market or the markets could not be loaded right now.
                The main design applies everywhere.
              </Text>
            ) : (
              <BlockStack gap="0">
                {markets.map((market) => (
                  <Box
                    key={market.handle}
                    paddingBlock="200"
                    borderBlockEndWidth="025"
                    borderColor="border"
                  >
                    <InlineStack
                      align="space-between"
                      blockAlign="center"
                      gap="300"
                      wrap
                    >
                      <InlineStack gap="200" blockAlign="center" wrap>
                        <Text as="span" fontWeight="medium">
                          {market.name}
                        </Text>
                        {market.primary ? (
                          <Badge tone="info">Primary</Badge>
                        ) : null}
                        <Text as="span" tone="subdued" variant="bodySm">
                          {market.handle}
                        </Text>
                      </InlineStack>
                      <Box minWidth="260px">
                        <Select
                          label={`Design for ${market.name}`}
                          labelHidden
                          options={marketPresetOptions}
                          value={draft.markets[market.handle]?.preset ?? ""}
                          onChange={(v) =>
                            setMarketPreset(
                              market.handle,
                              v as PresetKey | "",
                            )
                          }
                        />
                      </Box>
                    </InlineStack>
                  </Box>
                ))}
                {staleMarketHandles.map((handle) => (
                  <Box
                    key={handle}
                    paddingBlock="200"
                    borderBlockEndWidth="025"
                    borderColor="border"
                  >
                    <InlineStack
                      align="space-between"
                      blockAlign="center"
                      gap="300"
                      wrap
                    >
                      <InlineStack gap="200" blockAlign="center" wrap>
                        <Text as="span" fontWeight="medium">
                          {handle}
                        </Text>
                        <Badge tone="attention">
                          Not on your shop anymore
                        </Badge>
                      </InlineStack>
                      <Box minWidth="260px">
                        <Select
                          label={`Design for ${handle}`}
                          labelHidden
                          options={marketPresetOptions}
                          value={draft.markets[handle]?.preset ?? ""}
                          onChange={(v) =>
                            setMarketPreset(handle, v as PresetKey | "")
                          }
                          helpText='Pick "Default" to remove this leftover entry.'
                        />
                      </Box>
                    </InlineStack>
                  </Box>
                ))}
              </BlockStack>
            )}
            <Text as="p" variant="bodySm" tone="subdued">
              The storefront resolves the design from the market a visitor
              shops in, so the storefront preview link shows the market of
              the domain you open it on — check each market through its own
              domain. Note the Subscription max quiet defaults (no badge,
              hidden frequency selector) are layout settings of the MAIN
              design: a market override inherits your main layout.
            </Text>
          </BlockStack>
        </Card>

        {/* ── Placement (app embed) ── */}
        <Card>
          <BlockStack gap="300">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">
                Placement
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Where the widget mounts on the product page when it loads
                through the &quot;Cellexia Buy Box&quot; app embed (Theme
                editor → Theme settings → App embeds). If you added the
                buy-box app block to the product template instead, it always
                renders exactly where you placed it and this setting is
                ignored. Saved and published with the rest of the design.
              </Text>
            </BlockStack>
            <ChoiceList
              title="Mount point"
              titleHidden
              choices={[
                {
                  label: "Automatic (recommended)",
                  value: "auto",
                  helpText:
                    "The widget finds the buy column and inserts itself " +
                    "between the product options and the add-to-cart panel. " +
                    "Tuned for cellexialabs.com: it anchors just above the " +
                    "grey purchase panel (quantity + add to cart), right " +
                    "after the size selector, with generic fallbacks for " +
                    "other themes.",
                },
                {
                  label: "Custom CSS selector",
                  value: "selector",
                  helpText:
                    "Anchor the widget to a specific element when the " +
                    "automatic position isn't right for your theme.",
                },
              ]}
              selected={[draft.placement.mode]}
              onChange={(selected) =>
                setPlacement(
                  "mode",
                  (selected[0] ??
                    "auto") as WidgetDesignConfig["placement"]["mode"],
                )
              }
            />
            {draft.placement.mode === "selector" ? (
              <InlineStack gap="300" blockAlign="start" wrap>
                <Box minWidth="280px">
                  <TextField
                    label="CSS selector"
                    autoComplete="off"
                    value={draft.placement.selector}
                    onChange={(v) => setPlacement("selector", v)}
                    placeholder=".pdp__info .pdp__grey"
                    maxLength={200}
                    helpText='Example: ".pdp__info .pdp__grey" with position "Before the element" places the widget just above the quantity + add-to-cart panel on cellexialabs.com.'
                  />
                </Box>
                <Box minWidth="220px">
                  <Select
                    label="Position"
                    options={[
                      { label: "Before the element", value: "before" },
                      { label: "After the element", value: "after" },
                      {
                        label: "Inside, as first child (prepend)",
                        value: "prepend",
                      },
                      {
                        label: "Inside, as last child (append)",
                        value: "append",
                      },
                    ]}
                    value={draft.placement.position}
                    onChange={(v) =>
                      setPlacement(
                        "position",
                        v as WidgetDesignConfig["placement"]["position"],
                      )
                    }
                  />
                </Box>
              </InlineStack>
            ) : null}
          </BlockStack>
        </Card>

        {/* ── Theme integration (add-to-cart price sync) ── */}
        <Card>
          <BlockStack gap="300">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">
                Theme integration
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Many themes print the price inside their own Add to cart
                button (&quot;ADD TO CART - CHF 64.00&quot;). That is the
                one-time price, so with the subscription option selected the
                shopper sees one price in the widget and a different one on
                the button they are about to click.
              </Text>
            </BlockStack>
            <Checkbox
              label="Match the theme's Add to cart price to the selected option"
              checked={draft.themeSync.syncAddToCartPrice}
              onChange={(v) => setThemeSync("syncAddToCartPrice", v)}
              helpText={
                "Swaps the displayed price TEXT only — it never changes what " +
                "is added to the cart, and it puts the theme's own text back " +
                "the moment one-time is selected. If your theme's button " +
                "does not show a price, this silently does nothing."
              }
            />
            {draft.themeSync.syncAddToCartPrice ? (
              <Box minWidth="280px">
                <TextField
                  label="Add to cart button selector (optional)"
                  autoComplete="off"
                  value={draft.themeSync.priceSelector}
                  onChange={(v) => setThemeSync("priceSelector", v)}
                  placeholder=".pdp__actions .btn--atc"
                  maxLength={PRICE_SELECTOR_MAX_LENGTH}
                  helpText={
                    'Leave empty to use the built-in list (covers Dawn / OS 2.0 ' +
                    'and most themes). Set it when the price on your button is ' +
                    'not being updated — e.g. ".pdp__actions .btn--atc" for the ' +
                    "Sleepify theme on cellexialabs.com. Test it first with " +
                    "document.querySelector('…') in the browser console on a " +
                    "product page."
                  }
                />
              </Box>
            ) : null}
            <Checkbox
              label="Match the theme's main price display to the selected option"
              checked={draft.themeSync.syncMainPrice}
              onChange={(v) => setThemeSync("syncMainPrice", v)}
              helpText={
                "The price under the product title keeps quoting the " +
                "one-time price while the subscription is selected — this " +
                "swaps that displayed TEXT the same safe way as the button. " +
                "Struck-through compare-at and per-unit lines are left as " +
                "the theme printed them."
              }
            />
            {draft.themeSync.syncMainPrice ? (
              <Box minWidth="280px">
                <TextField
                  label="Main price selector (optional)"
                  autoComplete="off"
                  value={draft.themeSync.mainPriceSelector}
                  onChange={(v) => setThemeSync("mainPriceSelector", v)}
                  placeholder=".pdp__price"
                  maxLength={PRICE_SELECTOR_MAX_LENGTH}
                  helpText={
                    'Leave empty to use the built-in list (".pdp__price" for ' +
                    "cellexialabs.com, plus the Dawn / OS 2.0 patterns). Set " +
                    "it when your theme prints the main price somewhere the " +
                    "built-in list misses."
                  }
                />
              </Box>
            ) : null}
          </BlockStack>
        </Card>

        {/* ── Editor + live preview ── */}
        <InlineGrid columns={{ xs: 1, lg: 2 }} gap="400" alignItems="start">
          <Card>
            <BlockStack gap="300">
              <Tabs tabs={editorTabs} selected={tab} onSelect={setTab} fitted />

              {tab === 0 ? (
                <BlockStack gap="400">
                  <Select
                    label="Option order"
                    options={[
                      { label: "Subscription first", value: "sub_first" },
                      { label: "One-time first", value: "one_time_first" },
                    ]}
                    value={draft.layout.order}
                    onChange={(v) =>
                      setLayout("order", v as WidgetDesignConfig["layout"]["order"])
                    }
                  />
                  <Select
                    label="Density"
                    options={[
                      { label: "Comfortable", value: "comfortable" },
                      { label: "Compact", value: "compact" },
                    ]}
                    value={draft.layout.density}
                    onChange={(v) =>
                      setLayout(
                        "density",
                        v as WidgetDesignConfig["layout"]["density"],
                      )
                    }
                  />
                  <RangeSlider
                    label="Corner radius"
                    min={0}
                    max={24}
                    step={1}
                    value={draft.layout.radiusPx}
                    onChange={(v) =>
                      setLayout("radiusPx", Array.isArray(v) ? v[0] : v)
                    }
                    suffix={<Text as="span">{draft.layout.radiusPx}px</Text>}
                  />
                  <RangeSlider
                    label="Border width"
                    min={1}
                    max={3}
                    step={1}
                    value={draft.layout.borderWidthPx}
                    onChange={(v) =>
                      setLayout("borderWidthPx", Array.isArray(v) ? v[0] : v)
                    }
                    suffix={<Text as="span">{draft.layout.borderWidthPx}px</Text>}
                  />
                  <Checkbox
                    label="Show frequency selector"
                    checked={draft.layout.showFrequency}
                    onChange={(v) => setLayout("showFrequency", v)}
                    helpText="Hiding it removes the frequency choice from every preset and uses each plan's default delivery frequency — one less decision on the product page. Subscribers can still change their frequency any time in the portal."
                  />
                  <Select
                    label="Frequency selector style"
                    options={[
                      { label: "Dropdown", value: "dropdown" },
                      { label: "Chips", value: "chips" },
                    ]}
                    value={draft.layout.frequencyStyle}
                    disabled={!draft.layout.showFrequency}
                    onChange={(v) =>
                      setLayout(
                        "frequencyStyle",
                        v as WidgetDesignConfig["layout"]["frequencyStyle"],
                      )
                    }
                    helpText={
                      draft.layout.showFrequency
                        ? "The Routine planner preset always uses chips."
                        : "The frequency selector is hidden — each plan's default frequency applies."
                    }
                  />
                  <Divider />
                  <Checkbox
                    label="Show badge on the subscription option"
                    checked={draft.layout.showBadge}
                    onChange={(v) => setLayout("showBadge", v)}
                  />
                  <Checkbox
                    label="Show savings label"
                    checked={draft.layout.showSavings}
                    onChange={(v) => setLayout("showSavings", v)}
                  />
                  <Checkbox
                    label="Show per-delivery price"
                    checked={draft.layout.showPerDelivery}
                    onChange={(v) => setLayout("showPerDelivery", v)}
                  />
                  <Checkbox
                    label="Show struck-through compare-at price"
                    checked={draft.layout.showCompareAt}
                    onChange={(v) => setLayout("showCompareAt", v)}
                  />
                  <Checkbox
                    label="Show reassurance line"
                    checked={draft.layout.showReassurance}
                    onChange={(v) => setLayout("showReassurance", v)}
                  />
                  <Checkbox
                    label="Show benefit list"
                    checked={draft.layout.showBenefits}
                    onChange={(v) => setLayout("showBenefits", v)}
                    helpText="The Value stack preset always shows its benefit list."
                  />
                  <Select
                    label="Benefits shown"
                    options={[0, 1, 2, 3, 4, 5].map((n) => ({
                      label: String(n),
                      value: String(n),
                    }))}
                    value={String(draft.layout.benefitCount)}
                    onChange={(v) => setLayout("benefitCount", Number(v))}
                    helpText="How many benefit lines to display when the list is shown."
                  />
                </BlockStack>
              ) : null}

              {tab === 1 ? (
                <BlockStack gap="400">
                  <Select
                    label="Locale"
                    options={SUPPORTED_LOCALES}
                    value={textLocale}
                    onChange={setTextLocale}
                    helpText="Empty fields inherit: this locale → English override → the widget's built-in translations. Inherited values are shown as placeholders (in English)."
                  />
                  {TEXT_FIELDS.map((field) => (
                    <TextField
                      key={`${textLocale}-${field.key}`}
                      label={field.label}
                      autoComplete="off"
                      value={localeEntry[field.key] ?? ""}
                      onChange={(v) => setTextField(field.key, v)}
                      placeholder={inheritedPlaceholder(field.key)}
                      helpText={
                        field.templated
                          ? "Supports {percent}, {amount} and {frequency} placeholders."
                          : undefined
                      }
                    />
                  ))}
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">
                      Benefit list
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {localeBenefits.length === 0
                        ? `Inheriting the defaults: ${DEFAULT_BENEFITS.join(" · ")}`
                        : "Shown where the benefit list is enabled (always on Value stack)."}
                    </Text>
                    {localeBenefits.map((benefit, i) => (
                      <InlineStack
                        key={i}
                        gap="200"
                        blockAlign="center"
                        wrap={false}
                      >
                        <Box width="100%">
                          <TextField
                            label={`Benefit ${i + 1}`}
                            labelHidden
                            autoComplete="off"
                            value={benefit}
                            onChange={(v) =>
                              setBenefits(
                                localeBenefits.map((b, j) => (j === i ? v : b)),
                              )
                            }
                          />
                        </Box>
                        <Button
                          size="slim"
                          onClick={() =>
                            setBenefits(
                              localeBenefits.filter((_, j) => j !== i),
                            )
                          }
                          accessibilityLabel={`Remove benefit ${i + 1}`}
                        >
                          Remove
                        </Button>
                      </InlineStack>
                    ))}
                    {localeBenefits.length < 5 ? (
                      <Box>
                        <Button
                          size="slim"
                          onClick={() => setBenefits([...localeBenefits, ""])}
                        >
                          Add benefit
                        </Button>
                      </Box>
                    ) : null}
                  </BlockStack>
                </BlockStack>
              ) : null}

              {tab === 2 ? (
                <BlockStack gap="400">
                  <ColorField
                    label="Accent"
                    value={draft.style.accent}
                    fallbackHex="#1d1d1b"
                    onChange={(v) => setStyle("accent", v)}
                    helpText="Subscription border, badge, radio and savings color."
                  />
                  <ColorField
                    label="Text on accent"
                    value={draft.style.accentText}
                    fallbackHex="#ffffff"
                    onChange={(v) => setStyle("accentText", v)}
                    helpText="Used on accent surfaces like the active toggle tab."
                  />
                  <ColorField
                    label="Background tint"
                    value={draft.style.bgTint}
                    fallbackHex={draft.style.accent}
                    inheritable
                    onChange={(v) => setStyle("bgTint", v)}
                    helpText="Soft fill behind the subscription option. Inherit = accent at 7%."
                  />
                  <ColorField
                    label="Text color"
                    value={draft.style.text}
                    fallbackHex="#1d1d1b"
                    inheritable
                    onChange={(v) => setStyle("text", v)}
                    helpText="Inherit = the theme's own text color."
                  />
                  <ColorField
                    label="Badge background"
                    value={draft.style.badgeBg}
                    fallbackHex={draft.style.accent}
                    inheritable
                    onChange={(v) => setStyle("badgeBg", v)}
                    helpText="Inherit = the accent color."
                  />
                  <ColorField
                    label="Badge text"
                    value={draft.style.badgeText}
                    fallbackHex="#ffffff"
                    onChange={(v) => setStyle("badgeText", v)}
                  />
                  <RangeSlider
                    label="Font scale"
                    min={0.85}
                    max={1.15}
                    step={0.01}
                    value={draft.style.fontScale}
                    onChange={(v) =>
                      setStyle("fontScale", Array.isArray(v) ? v[0] : v)
                    }
                    suffix={
                      <Text as="span">
                        {Math.round(draft.style.fontScale * 100)}%
                      </Text>
                    }
                  />
                  <div className="cx-css-mono">
                    <TextField
                      label="Custom CSS"
                      autoComplete="off"
                      multiline={6}
                      value={draft.style.customCss}
                      onChange={(v) => setStyle("customCss", v)}
                      maxLength={5000}
                      showCharacterCount
                      helpText="Applied only inside the widget wrapper. Sanitized on save and publish: @import, expression(), url() with external schemes, HTML tags and javascript: are stripped; 5,000-character limit."
                    />
                  </div>
                </BlockStack>
              ) : null}

              {tab === 3 ? (
                <BlockStack gap="400">
                  <Select
                    label="Preselected option"
                    options={[
                      { label: "Inherit theme block setting", value: "inherit" },
                      { label: "Subscription", value: "subscription" },
                      { label: "One-time", value: "one_time" },
                    ]}
                    value={draft.behavior.preselect}
                    onChange={(v) =>
                      setBehavior(
                        "preselect",
                        v as WidgetDesignConfig["behavior"]["preselect"],
                      )
                    }
                    helpText="Preselecting subscription is the single biggest take-rate lever on the PDP."
                  />
                  <Checkbox
                    label="Enable micro-animations"
                    checked={draft.behavior.animation}
                    onChange={(v) => setBehavior("animation", v)}
                    helpText="Respects the visitor's reduced-motion preference either way."
                  />
                </BlockStack>
              ) : null}
            </BlockStack>
          </Card>

          <div style={{ position: "sticky", top: "16px" }}>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <Text as="h2" variant="headingMd">
                    Live preview
                  </Text>
                  <InlineStack gap="200" wrap>
                    <ButtonGroup variant="segmented">
                      <Button
                        size="slim"
                        pressed={previewWidth === "desktop"}
                        onClick={() => setPreviewWidth("desktop")}
                      >
                        Desktop
                      </Button>
                      <Button
                        size="slim"
                        pressed={previewWidth === "mobile"}
                        onClick={() => setPreviewWidth("mobile")}
                      >
                        Mobile
                      </Button>
                    </ButtonGroup>
                    <ButtonGroup variant="segmented">
                      <Button
                        size="slim"
                        pressed={previewState === "subscription"}
                        onClick={() => setPreviewState("subscription")}
                      >
                        Subscription
                      </Button>
                      <Button
                        size="slim"
                        pressed={previewState === "one_time"}
                        onClick={() => setPreviewState("one_time")}
                      >
                        One-time
                      </Button>
                    </ButtonGroup>
                  </InlineStack>
                </InlineStack>
                {markets.length > 0 ? (
                  <Select
                    label="Preview market"
                    options={[
                      {
                        label: `Default — all markets (${presetName(draft.preset)})`,
                        value: "",
                      },
                      ...markets.map((market) => ({
                        label: `${market.name} — ${presetName(resolveMarketPreset(market.handle))}`,
                        value: market.handle,
                      })),
                    ]}
                    value={previewMarket}
                    onChange={setPreviewMarket}
                    helpText="Renders the preset that market resolves to — a client-side preview only, nothing is published."
                  />
                ) : null}
                <Box
                  borderColor="border"
                  borderWidth="025"
                  borderRadius="200"
                  padding="400"
                  background="bg-surface"
                >
                  <div
                    style={{
                      maxWidth: previewWidth === "mobile" ? 375 : 720,
                      margin: "0 auto",
                    }}
                  >
                    <BuyBoxPreview
                      config={draft}
                      preset={previewPreset}
                      locale={textLocale}
                      selected={previewState}
                    />
                  </div>
                </Box>
                <Text as="p" variant="bodySm" tone="subdued">
                  Preview uses a sample product (Cellexia Renewal Serum,
                  CHF 68.00, 20% first order / 10% ongoing, every 6–12 weeks)
                  in a frame styled after cellexialabs.com. Final rendering
                  can differ slightly by theme — always confirm with the
                  storefront preview.
                </Text>
                <Box>
                  <Button url="/app/preview">View on your store</Button>
                </Box>
              </BlockStack>
            </Card>
          </div>
        </InlineGrid>

        {/* ── Revision history ── */}
        <Card>
          <BlockStack gap="300">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">
                Revision history
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Every save and publish is kept. Restore republishes an older
                design instantly; previewing loads it into the editor without
                touching the storefront.
              </Text>
            </BlockStack>
            <Divider />
            {revisions.length === 0 ? (
              <Text as="p" tone="subdued">
                No revisions yet — save a draft or publish to start the
                history. Until a design is published, the storefront renders
                the built-in default.
              </Text>
            ) : (
              <BlockStack gap="0">
                {revisions.map((rev) => (
                  <Box
                    key={rev.id}
                    paddingBlock="200"
                    borderBlockEndWidth="025"
                    borderColor="border"
                  >
                    <InlineStack
                      align="space-between"
                      blockAlign="center"
                      gap="300"
                      wrap
                    >
                      <InlineStack gap="200" blockAlign="center" wrap>
                        <Text as="span" fontWeight="medium">
                          {presetName(rev.preset)}
                        </Text>
                        {rev.publishedAt ? (
                          <Badge tone="success">Published</Badge>
                        ) : (
                          <Badge>Draft</Badge>
                        )}
                        <Text as="span" tone="subdued" variant="bodySm">
                          {formatRevisionDate(rev.createdAt)}
                          {rev.createdBy ? ` · ${rev.createdBy}` : ""}
                        </Text>
                      </InlineStack>
                      <InlineStack gap="200" wrap={false}>
                        <Button
                          size="slim"
                          disabled={!rev.config}
                          onClick={() => {
                            if (!rev.config) return;
                            if (dirty) setLoadTarget(rev);
                            else setDraft(rev.config);
                          }}
                        >
                          Preview in editor
                        </Button>
                        <Button
                          size="slim"
                          disabled={!rev.config}
                          onClick={() => setRestoreTarget(rev)}
                        >
                          Restore
                        </Button>
                      </InlineStack>
                    </InlineStack>
                  </Box>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </Card>

        {/* ── Design performance ── */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Design performance — last {performance.rangeDays} days
            </Text>
            {performance.rows.length === 0 ? (
              <Text as="p" tone="subdued">
                No design-attributed subscription orders yet. Every
                subscription add-to-cart is stamped with the active design
                key, so rows appear here as soon as subscription orders
                arrive
                {launchMode === "SETUP" ? " (after you go live)" : ""}.
              </Text>
            ) : (
              <BlockStack gap="200">
                <DataTable
                  columnContentTypes={["text", "numeric", "numeric"]}
                  headings={["Design", "Subscription orders", "Share"]}
                  rows={performanceRows}
                />
                <Text as="p" variant="bodySm" tone="subdued">
                  {`${performance.totalAttributed} attributed subscription order${performance.totalAttributed === 1 ? "" : "s"}`}
                  {performance.checkoutDenominator > 0
                    ? ` across ${performance.checkoutDenominator} subscribable checkouts (the take-rate denominator).`
                    : "."}
                </Text>
              </BlockStack>
            )}
            <Text as="p" variant="bodySm" tone="subdued">
              Methodology: change one design at a time, and watch PDP
              conversion rate AND subscription take rate for at least a full
              traffic cycle (7+ days) before judging it. If conversion dips,
              restore the previous design instantly from the revision history.
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>

      {/* ── Publish confirm ── */}
      <Modal
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        title={`Publish the ${presetName(draft.preset)} design?`}
        primaryAction={{
          content: "Publish",
          loading: busy && navIntent === "publish",
          onAction: () => submitConfig("publish"),
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setPublishOpen(false) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="p">
              {launchMode === "LIVE"
                ? "Publishing updates the buy box on your live product pages immediately."
                : "You're in Setup mode: the design is published but stays invisible to store visitors until you go live from Preview & launch."}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              You can restore any previous design instantly from the revision
              history.
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* ── Preset switch confirm (unsaved changes) ── */}
      <Modal
        open={pendingPreset != null}
        onClose={() => setPendingPreset(null)}
        title={
          pendingPreset
            ? `Switch to ${presetName(pendingPreset)}?`
            : "Switch preset"
        }
        primaryAction={{
          content: "Switch preset",
          onAction: () => {
            if (pendingPreset) {
              setDraft((d) => applyPresetDefaults(d, pendingPreset));
            }
            setPendingPreset(null);
          },
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setPendingPreset(null) },
        ]}
      >
        <Modal.Section>
          <Text as="p">
            You have unsaved changes. Your text, style and layout
            customizations carry over where the new preset supports them, but
            preset-specific defaults may overwrite some layout settings. Save
            a draft first if you want to keep the current state in history.
          </Text>
        </Modal.Section>
      </Modal>

      {/* ── Load revision confirm (unsaved changes) ── */}
      <Modal
        open={loadTarget != null}
        onClose={() => setLoadTarget(null)}
        title="Load this revision into the editor?"
        primaryAction={{
          content: "Load revision",
          onAction: () => {
            if (loadTarget?.config) setDraft(loadTarget.config);
            setLoadTarget(null);
          },
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setLoadTarget(null) },
        ]}
      >
        <Modal.Section>
          <Text as="p">
            Your unsaved changes will be discarded and replaced with the
            selected revision. Nothing changes on the storefront until you
            publish.
          </Text>
        </Modal.Section>
      </Modal>

      {/* ── Restore confirm ── */}
      <Modal
        open={restoreTarget != null}
        onClose={() => setRestoreTarget(null)}
        title={
          restoreTarget
            ? `Restore the ${presetName(restoreTarget.preset)} design from ${formatRevisionDate(restoreTarget.createdAt)}?`
            : "Restore design"
        }
        primaryAction={{
          content: "Restore & publish",
          loading: busy && navIntent === "restore",
          onAction: () => {
            if (restoreTarget) {
              submit(
                { intent: "restore", revisionId: restoreTarget.id },
                { method: "post" },
              );
            }
          },
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setRestoreTarget(null) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="p">
              {launchMode === "LIVE"
                ? "The selected design is copied into a new revision and published to your storefront immediately."
                : "The selected design is copied into a new revision and published (it stays invisible until you go live)."}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              The editor reloads with the restored design; unsaved editor
              changes are replaced.
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
