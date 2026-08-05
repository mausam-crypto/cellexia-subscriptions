/**
 * Admin — Widgets & offers.
 *
 * CRUD for WidgetConfig rows (per widget type: targeting, priority, settings
 * overrides prefilled from the brand-default copy) and Experiments (variants
 * with weights, DRAFT → RUNNING → COMPLETED transitions), plus a small
 * assignment / telemetry summary from AnalyticsEvent WIDGET_* rows.
 */
import { useCallback, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  DataTable,
  Divider,
  FormLayout,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { appendAudit } from "~/services/audit.server";
import { requireRole } from "~/services/core/rbac.server";
import { DEFAULT_WIDGET_SETTINGS } from "~/services/offers/widgets.server";
import { EXPERIMENT_STATUSES, WIDGET_TYPES, parseJson } from "~/types/domain";
import type { ExperimentStatus, WidgetType } from "~/types/domain";

type ActionResponse = { ok: boolean; message?: string; error?: string };

const WIDGET_TYPE_LABELS: Record<WidgetType, string> = {
  TREATMENT_CHOICE: "A — Treatment choice",
  QUANTITY_CADENCE: "B — Quantity & cadence",
  ROUTINE_BUILDER: "D — Routine builder (portal)",
  POST_ONE_TIME: "E — Post one-time nudge",
  CART_CONVERSION: "F — Cart conversion",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireRole(session, "OWNER", "ADMIN");

  const [widgets, experiments, assignmentGroups, telemetryRows] =
    await Promise.all([
      prisma.widgetConfig.findMany({
        where: { shop: session.shop },
        orderBy: [{ widgetType: "asc" }, { priority: "desc" }],
      }),
      prisma.experiment.findMany({
        where: { shop: session.shop },
        orderBy: { createdAt: "desc" },
      }),
      prisma.experimentAssignment.groupBy({
        by: ["experimentId", "variantKey"],
        where: { experiment: { shop: session.shop } },
        _count: { _all: true },
      }),
      prisma.analyticsEvent.findMany({
        where: { shop: session.shop, name: { startsWith: "WIDGET_" } },
        orderBy: { occurredAt: "desc" },
        take: 1000,
        select: { name: true, payloadJson: true },
      }),
    ]);

  const assignmentCounts = assignmentGroups.map((group) => ({
    experimentId: group.experimentId,
    variantKey: group.variantKey,
    count: group._count._all,
  }));

  // Aggregate recent WIDGET_* telemetry by (event name, variantKey).
  const telemetryMap = new Map<string, number>();
  for (const row of telemetryRows) {
    const payload = parseJson<{ variantKey?: string | null }>(
      row.payloadJson,
      {},
    );
    const key = `${row.name}::${payload.variantKey ?? "(none)"}`;
    telemetryMap.set(key, (telemetryMap.get(key) ?? 0) + 1);
  }
  const telemetry = [...telemetryMap.entries()]
    .map(([key, count]) => {
      const [name, variantKey] = key.split("::");
      return { name, variantKey, count };
    })
    .sort((a, b) => b.count - a.count);

  return json({
    widgets,
    experiments,
    assignmentCounts,
    telemetry,
    defaults: DEFAULT_WIDGET_SETTINGS,
  });
};

function validateJsonObjectString(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireRole(session, "OWNER", "ADMIN");
  const staffId =
    session.onlineAccessInfo?.associated_user?.email ?? session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "widget-save") {
      const id = String(form.get("id") ?? "").trim();
      const widgetType = String(form.get("widgetType") ?? "");
      if (!(WIDGET_TYPES as readonly string[]).includes(widgetType)) {
        return json<ActionResponse>(
          { ok: false, error: "Invalid widget type." },
          { status: 400 },
        );
      }
      const name = String(form.get("name") ?? "").trim();
      if (!name) {
        return json<ActionResponse>(
          { ok: false, error: "Name is required." },
          { status: 400 },
        );
      }
      const priority =
        Number.parseInt(String(form.get("priority") ?? "0"), 10) || 0;
      const active = String(form.get("active") ?? "") === "true";

      const targetingJson = validateJsonObjectString(
        String(form.get("targetingJson") ?? "{}"),
      );
      if (!targetingJson) {
        return json<ActionResponse>(
          { ok: false, error: "Targeting must be a valid JSON object." },
          { status: 400 },
        );
      }
      const settingsJson = validateJsonObjectString(
        String(form.get("settingsJson") ?? "{}"),
      );
      if (!settingsJson) {
        return json<ActionResponse>(
          { ok: false, error: "Settings must be a valid JSON object." },
          { status: 400 },
        );
      }

      const experimentId =
        String(form.get("experimentId") ?? "").trim() || null;
      if (experimentId) {
        const experiment = await prisma.experiment.findFirst({
          where: { id: experimentId, shop: session.shop },
          select: { id: true },
        });
        if (!experiment) {
          return json<ActionResponse>(
            { ok: false, error: "Experiment not found." },
            { status: 404 },
          );
        }
      }

      const existing = id
        ? await prisma.widgetConfig.findFirst({
            where: { id, shop: session.shop },
          })
        : null;
      if (id && !existing) {
        return json<ActionResponse>(
          { ok: false, error: "Widget configuration not found." },
          { status: 404 },
        );
      }

      const data = {
        widgetType,
        name,
        priority,
        active,
        targetingJson,
        settingsJson,
        experimentId,
      };
      const saved = existing
        ? await prisma.widgetConfig.update({
            where: { id: existing.id },
            data,
          })
        : await prisma.widgetConfig.create({
            data: { ...data, shop: session.shop },
          });

      await appendAudit({
        shop: session.shop,
        actorType: "STAFF",
        actorId: staffId,
        action: existing ? "WIDGET_CONFIG_UPDATED" : "WIDGET_CONFIG_CREATED",
        subjectType: "WidgetConfig",
        subjectId: saved.id,
        payload: { widgetType, name, priority, active, experimentId },
      });

      return json<ActionResponse>({
        ok: true,
        message: "Widget configuration saved.",
      });
    }

    if (intent === "widget-delete") {
      const id = String(form.get("id") ?? "").trim();
      const existing = await prisma.widgetConfig.findFirst({
        where: { id, shop: session.shop },
      });
      if (!existing) {
        return json<ActionResponse>(
          { ok: false, error: "Widget configuration not found." },
          { status: 404 },
        );
      }
      await prisma.widgetConfig.delete({ where: { id: existing.id } });
      await appendAudit({
        shop: session.shop,
        actorType: "STAFF",
        actorId: staffId,
        action: "WIDGET_CONFIG_DELETED",
        subjectType: "WidgetConfig",
        subjectId: existing.id,
        payload: { widgetType: existing.widgetType, name: existing.name },
      });
      return json<ActionResponse>({
        ok: true,
        message: "Widget configuration deleted.",
      });
    }

    if (intent === "experiment-save") {
      const id = String(form.get("id") ?? "").trim();
      const name = String(form.get("name") ?? "").trim();
      if (!name) {
        return json<ActionResponse>(
          { ok: false, error: "Experiment name is required." },
          { status: 400 },
        );
      }

      const rawVariants = parseJson<Array<Record<string, unknown>>>(
        String(form.get("variantsJson") ?? "[]"),
        [],
      );
      const variants: Array<{
        key: string;
        weight: number;
        settingsJson?: string;
      }> = [];
      for (const raw of rawVariants) {
        const key = typeof raw.key === "string" ? raw.key.trim() : "";
        const weight =
          typeof raw.weight === "number" &&
          Number.isFinite(raw.weight) &&
          raw.weight > 0
            ? raw.weight
            : null;
        if (!key || weight === null) continue;
        let settingsJson: string | undefined;
        if (typeof raw.settingsJson === "string" && raw.settingsJson.trim()) {
          const validated = validateJsonObjectString(raw.settingsJson);
          if (!validated) {
            return json<ActionResponse>(
              {
                ok: false,
                error: `Variant "${key}" settings must be a valid JSON object.`,
              },
              { status: 400 },
            );
          }
          settingsJson = validated;
        }
        variants.push({ key, weight, ...(settingsJson ? { settingsJson } : {}) });
      }
      if (variants.length === 0) {
        return json<ActionResponse>(
          {
            ok: false,
            error: "At least one variant with a key and a positive weight is required.",
          },
          { status: 400 },
        );
      }
      const keys = variants.map((v) => v.key);
      if (new Set(keys).size !== keys.length) {
        return json<ActionResponse>(
          { ok: false, error: "Variant keys must be unique." },
          { status: 400 },
        );
      }

      const existing = id
        ? await prisma.experiment.findFirst({
            where: { id, shop: session.shop },
          })
        : null;
      if (id && !existing) {
        return json<ActionResponse>(
          { ok: false, error: "Experiment not found." },
          { status: 404 },
        );
      }
      if (existing && existing.status !== "DRAFT") {
        return json<ActionResponse>(
          {
            ok: false,
            error:
              "Only DRAFT experiments can be edited — variants must stay stable once assignment has started.",
          },
          { status: 400 },
        );
      }

      const saved = existing
        ? await prisma.experiment.update({
            where: { id: existing.id },
            data: { name, variantsJson: JSON.stringify(variants) },
          })
        : await prisma.experiment.create({
            data: {
              shop: session.shop,
              name,
              variantsJson: JSON.stringify(variants),
              status: "DRAFT",
            },
          });

      await appendAudit({
        shop: session.shop,
        actorType: "STAFF",
        actorId: staffId,
        action: existing ? "EXPERIMENT_UPDATED" : "EXPERIMENT_CREATED",
        subjectType: "Experiment",
        subjectId: saved.id,
        payload: { name, variants },
      });

      return json<ActionResponse>({ ok: true, message: "Experiment saved." });
    }

    if (intent === "experiment-status") {
      const id = String(form.get("id") ?? "").trim();
      const nextStatus = String(form.get("status") ?? "");
      if (!(EXPERIMENT_STATUSES as readonly string[]).includes(nextStatus)) {
        return json<ActionResponse>(
          { ok: false, error: "Invalid status." },
          { status: 400 },
        );
      }
      const experiment = await prisma.experiment.findFirst({
        where: { id, shop: session.shop },
      });
      if (!experiment) {
        return json<ActionResponse>(
          { ok: false, error: "Experiment not found." },
          { status: 404 },
        );
      }
      const allowed =
        (experiment.status === "DRAFT" && nextStatus === "RUNNING") ||
        (experiment.status === "RUNNING" && nextStatus === "COMPLETED");
      if (!allowed) {
        return json<ActionResponse>(
          {
            ok: false,
            error: `Cannot move experiment from ${experiment.status} to ${nextStatus}.`,
          },
          { status: 400 },
        );
      }

      await prisma.experiment.update({
        where: { id: experiment.id },
        data: {
          status: nextStatus as ExperimentStatus,
          ...(nextStatus === "RUNNING" ? { startedAt: new Date() } : {}),
          ...(nextStatus === "COMPLETED" ? { endedAt: new Date() } : {}),
        },
      });

      await appendAudit({
        shop: session.shop,
        actorType: "STAFF",
        actorId: staffId,
        action: "EXPERIMENT_STATUS_CHANGED",
        subjectType: "Experiment",
        subjectId: experiment.id,
        payload: { from: experiment.status, to: nextStatus },
      });

      return json<ActionResponse>({
        ok: true,
        message: `Experiment is now ${nextStatus}.`,
      });
    }

    return json<ActionResponse>(
      { ok: false, error: "Unknown action." },
      { status: 400 },
    );
  } catch (error) {
    return json<ActionResponse>(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Something went wrong.",
      },
      { status: 500 },
    );
  }
};

interface VariantRowState {
  key: string;
  weight: string;
  settingsJson: string;
}

const EMPTY_VARIANT_ROW: VariantRowState = {
  key: "",
  weight: "50",
  settingsJson: "",
};

export default function WidgetsPage() {
  const { widgets, experiments, assignmentCounts, telemetry, defaults } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const isSubmitting = navigation.state === "submitting";

  // ── Widget editor state ──
  const [editingWidgetId, setEditingWidgetId] = useState<string | null>(null);
  const [wType, setWType] = useState<string>("TREATMENT_CHOICE");
  const [wName, setWName] = useState("");
  const [wPriority, setWPriority] = useState("0");
  const [wActive, setWActive] = useState(true);
  const [wTargeting, setWTargeting] = useState("{}");
  const [wSettings, setWSettings] = useState(() =>
    JSON.stringify(defaults.TREATMENT_CHOICE, null, 2),
  );
  const [settingsTouched, setSettingsTouched] = useState(false);
  const [wExperimentId, setWExperimentId] = useState("");

  // ── Experiment editor state ──
  const [editingExperimentId, setEditingExperimentId] = useState<string | null>(
    null,
  );
  const [eName, setEName] = useState("");
  const [variantRows, setVariantRows] = useState<VariantRowState[]>([
    { key: "control", weight: "50", settingsJson: "" },
    { key: "treatment", weight: "50", settingsJson: "" },
  ]);

  const startNewWidget = useCallback(() => {
    setEditingWidgetId(null);
    setWType("TREATMENT_CHOICE");
    setWName("");
    setWPriority("0");
    setWActive(true);
    setWTargeting("{}");
    setWSettings(JSON.stringify(defaults.TREATMENT_CHOICE, null, 2));
    setSettingsTouched(false);
    setWExperimentId("");
  }, [defaults]);

  const startEditWidget = useCallback(
    (widgetId: string) => {
      const widget = widgets.find((w) => w.id === widgetId);
      if (!widget) return;
      setEditingWidgetId(widget.id);
      setWType(widget.widgetType);
      setWName(widget.name);
      setWPriority(String(widget.priority));
      setWActive(widget.active);
      setWTargeting(widget.targetingJson);
      setWSettings(widget.settingsJson);
      setSettingsTouched(true);
      setWExperimentId(widget.experimentId ?? "");
    },
    [widgets],
  );

  const handleTypeChange = useCallback(
    (value: string) => {
      setWType(value);
      if (!settingsTouched) {
        const key = value as WidgetType;
        setWSettings(JSON.stringify(defaults[key] ?? {}, null, 2));
      }
    },
    [defaults, settingsTouched],
  );

  const handleWidgetSave = useCallback(() => {
    const formData = new FormData();
    formData.set("intent", "widget-save");
    formData.set("id", editingWidgetId ?? "");
    formData.set("widgetType", wType);
    formData.set("name", wName);
    formData.set("priority", wPriority);
    formData.set("active", wActive ? "true" : "false");
    formData.set("targetingJson", wTargeting);
    formData.set("settingsJson", wSettings);
    formData.set("experimentId", wExperimentId);
    submit(formData, { method: "post" });
  }, [
    editingWidgetId,
    wType,
    wName,
    wPriority,
    wActive,
    wTargeting,
    wSettings,
    wExperimentId,
    submit,
  ]);

  const handleWidgetDelete = useCallback(
    (widgetId: string) => {
      const formData = new FormData();
      formData.set("intent", "widget-delete");
      formData.set("id", widgetId);
      submit(formData, { method: "post" });
    },
    [submit],
  );

  const startNewExperiment = useCallback(() => {
    setEditingExperimentId(null);
    setEName("");
    setVariantRows([
      { key: "control", weight: "50", settingsJson: "" },
      { key: "treatment", weight: "50", settingsJson: "" },
    ]);
  }, []);

  const startEditExperiment = useCallback(
    (experimentId: string) => {
      const experiment = experiments.find((e) => e.id === experimentId);
      if (!experiment) return;
      setEditingExperimentId(experiment.id);
      setEName(experiment.name);
      const variants = parseJson<
        Array<{ key?: string; weight?: number; settingsJson?: string }>
      >(experiment.variantsJson, []);
      setVariantRows(
        variants.length > 0
          ? variants.map((v) => ({
              key: String(v.key ?? ""),
              weight: String(v.weight ?? "50"),
              settingsJson:
                typeof v.settingsJson === "string" ? v.settingsJson : "",
            }))
          : [{ ...EMPTY_VARIANT_ROW }],
      );
    },
    [experiments],
  );

  const handleExperimentSave = useCallback(() => {
    const formData = new FormData();
    formData.set("intent", "experiment-save");
    formData.set("id", editingExperimentId ?? "");
    formData.set("name", eName);
    formData.set(
      "variantsJson",
      JSON.stringify(
        variantRows.map((row) => ({
          key: row.key,
          weight: Number.parseFloat(row.weight) || 0,
          ...(row.settingsJson.trim()
            ? { settingsJson: row.settingsJson }
            : {}),
        })),
      ),
    );
    submit(formData, { method: "post" });
  }, [editingExperimentId, eName, variantRows, submit]);

  const handleExperimentStatus = useCallback(
    (experimentId: string, status: string) => {
      const formData = new FormData();
      formData.set("intent", "experiment-status");
      formData.set("id", experimentId);
      formData.set("status", status);
      submit(formData, { method: "post" });
    },
    [submit],
  );

  const updateVariantRow = useCallback(
    (index: number, field: keyof VariantRowState, value: string) => {
      setVariantRows((rows) =>
        rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
      );
    },
    [],
  );

  const experimentNameById = new Map<string, string>(
    experiments.map((e) => [e.id, e.name]),
  );

  const widgetRows = widgets.map((widget) => [
    WIDGET_TYPE_LABELS[widget.widgetType as WidgetType] ?? widget.widgetType,
    widget.name,
    String(widget.priority),
    widget.targetingJson.length > 60
      ? `${widget.targetingJson.slice(0, 60)}…`
      : widget.targetingJson,
    widget.experimentId
      ? experimentNameById.get(widget.experimentId) ?? widget.experimentId
      : "—",
    widget.active ? (
      <Badge tone="success" key={`${widget.id}-b`}>
        Active
      </Badge>
    ) : (
      <Badge key={`${widget.id}-b`}>Inactive</Badge>
    ),
    <InlineStack gap="200" key={`${widget.id}-a`}>
      <Button variant="plain" onClick={() => startEditWidget(widget.id)}>
        Edit
      </Button>
      <Button
        variant="plain"
        tone="critical"
        onClick={() => handleWidgetDelete(widget.id)}
      >
        Delete
      </Button>
    </InlineStack>,
  ]);

  const experimentRows = experiments.map((experiment) => {
    const variants = parseJson<Array<{ key?: string; weight?: number }>>(
      experiment.variantsJson,
      [],
    );
    return [
      experiment.name,
      <Badge
        key={`${experiment.id}-s`}
        tone={
          experiment.status === "RUNNING"
            ? "success"
            : experiment.status === "COMPLETED"
              ? "info"
              : undefined
        }
      >
        {experiment.status}
      </Badge>,
      variants.map((v) => `${v.key} (${v.weight})`).join(" / "),
      <InlineStack gap="200" key={`${experiment.id}-a`}>
        {experiment.status === "DRAFT" ? (
          <>
            <Button
              variant="plain"
              onClick={() => startEditExperiment(experiment.id)}
            >
              Edit
            </Button>
            <Button
              variant="plain"
              onClick={() => handleExperimentStatus(experiment.id, "RUNNING")}
            >
              Start
            </Button>
          </>
        ) : null}
        {experiment.status === "RUNNING" ? (
          <Button
            variant="plain"
            onClick={() => handleExperimentStatus(experiment.id, "COMPLETED")}
          >
            Complete
          </Button>
        ) : null}
      </InlineStack>,
    ];
  });

  const assignmentRows = assignmentCounts.map((row) => [
    experimentNameById.get(row.experimentId) ?? row.experimentId,
    row.variantKey,
    row.count,
  ]);

  const telemetryTableRows = telemetry.map((row) => [
    row.name,
    row.variantKey,
    row.count,
  ]);

  const experimentOptions = [
    { label: "No experiment", value: "" },
    ...experiments.map((e) => ({
      label: `${e.name} (${e.status})`,
      value: e.id,
    })),
  ];

  const widgetTypeOptions = WIDGET_TYPES.map((type) => ({
    label: WIDGET_TYPE_LABELS[type],
    value: type,
  }));

  return (
    <Page
      title="Widgets & offers"
      subtitle="Storefront widget configuration, targeting and experiments"
      primaryAction={{ content: "New widget config", onAction: startNewWidget }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData?.error ? (
              <Banner title={actionData.error} tone="critical" />
            ) : null}
            {actionData?.message ? (
              <Banner title={actionData.message} tone="success" />
            ) : null}

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Widget configurations
                </Text>
                <Text as="p" tone="subdued">
                  For each widget type, the highest-priority configuration
                  whose targeting matches the storefront context wins. With no
                  match, the brand-default copy is served.
                </Text>
                {widgets.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No widget configurations yet — storefront widgets are using
                    the brand defaults.
                  </Text>
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
                      "Type",
                      "Name",
                      "Priority",
                      "Targeting",
                      "Experiment",
                      "Status",
                      "",
                    ]}
                    rows={widgetRows}
                  />
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  {editingWidgetId ? "Edit widget config" : "New widget config"}
                </Text>
                <FormLayout>
                  <FormLayout.Group>
                    <Select
                      label="Widget type"
                      options={widgetTypeOptions}
                      value={wType}
                      onChange={handleTypeChange}
                    />
                    <TextField
                      label="Name"
                      value={wName}
                      onChange={setWName}
                      autoComplete="off"
                      helpText="Internal label, e.g. “PDP hero products — DE market”."
                    />
                  </FormLayout.Group>
                  <FormLayout.Group>
                    <TextField
                      label="Priority"
                      type="number"
                      value={wPriority}
                      onChange={setWPriority}
                      autoComplete="off"
                      helpText="Higher wins when several configs match."
                    />
                    <Select
                      label="Experiment"
                      options={experimentOptions}
                      value={wExperimentId}
                      onChange={setWExperimentId}
                      helpText="Only RUNNING experiments affect visitors."
                    />
                  </FormLayout.Group>
                  <Checkbox
                    label="Active"
                    checked={wActive}
                    onChange={setWActive}
                  />
                  <TextField
                    label="Targeting (JSON)"
                    value={wTargeting}
                    onChange={setWTargeting}
                    autoComplete="off"
                    multiline={4}
                    helpText={
                      'Fields: {"productIds": ["gid://shopify/Product/…"], "markets": ["de"] (Shopify market handles, not country codes), "trafficSources": ["email"], "returningOnly": true, "intentBands": ["high"]}. Empty or missing fields mean no restriction.'
                    }
                  />
                  <TextField
                    label="Settings (JSON)"
                    value={wSettings}
                    onChange={(value) => {
                      setWSettings(value);
                      setSettingsTouched(true);
                    }}
                    autoComplete="off"
                    multiline={10}
                    helpText={
                      'Overrides merged over the brand-default copy. {percent} placeholders are filled from the product\'s selling plan on the storefront. For widget A, the committed block configures the Committed Treatment Plan card: set committed.enabled to true and use committed.position to order it — 1 renders it as the first card and pre-selected default, 2 second, 3 third. Widget A also carries a style key with three values: "choice" (default chooser cards), "max" (Subscription Max — one full-width Continuous Treatment card, the one-time purchase demoted to a quiet text link, comparison nudge off) or "ultra" (Subscription Max Ultra — the page reads like a normal purchase: no card, no heading, no plan naming, no savings claims; the plan price simply is the price; the committed card never renders in ultra, and the comparison nudge never renders. Pair it with the theme block\'s quantity_label setting set to "Units"). The style applies ONLY when explicitly set — leave it out to keep the theme-resolved style. To switch one market from here, create a config with targeting {"markets": ["fr"]} and settings {"style": "max"} (or "ultra") — it wins over the theme after the widget-config fetch. Markets targeting values are Shopify market HANDLES (matched case-insensitively against localization.market.handle, the same keys market_styles uses), not ISO country codes — a multi-country market matches only its own handle (e.g. "eu"). For zero-latency first paint, prefer the theme editor\'s market_styles block setting instead (e.g. "fr:ultra, de:choice").'
                    }
                  />
                  <InlineStack gap="200">
                    <Button
                      variant="primary"
                      onClick={handleWidgetSave}
                      loading={isSubmitting}
                    >
                      {editingWidgetId ? "Save widget config" : "Create widget config"}
                    </Button>
                    <Button
                      variant="plain"
                      onClick={() => {
                        const key = wType as WidgetType;
                        setWSettings(
                          JSON.stringify(defaults[key] ?? {}, null, 2),
                        );
                        setSettingsTouched(true);
                      }}
                    >
                      Reset settings to defaults
                    </Button>
                    {editingWidgetId ? (
                      <Button variant="plain" onClick={startNewWidget}>
                        Cancel editing
                      </Button>
                    ) : null}
                  </InlineStack>
                </FormLayout>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Experiments
                  </Text>
                  <Button variant="plain" onClick={startNewExperiment}>
                    New experiment
                  </Button>
                </InlineStack>
                {experiments.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No experiments yet.
                  </Text>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text"]}
                    headings={["Name", "Status", "Variants (weight)", ""]}
                    rows={experimentRows}
                  />
                )}

                <Divider />

                <Text as="h3" variant="headingSm">
                  {editingExperimentId ? "Edit experiment" : "New experiment"}
                </Text>
                <TextField
                  label="Name"
                  value={eName}
                  onChange={setEName}
                  autoComplete="off"
                />
                <BlockStack gap="200">
                  {variantRows.map((row, index) => (
                    <InlineStack gap="200" blockAlign="end" key={index} wrap={false}>
                      <TextField
                        label="Variant key"
                        value={row.key}
                        onChange={(value) => updateVariantRow(index, "key", value)}
                        autoComplete="off"
                      />
                      <TextField
                        label="Weight"
                        type="number"
                        value={row.weight}
                        onChange={(value) =>
                          updateVariantRow(index, "weight", value)
                        }
                        autoComplete="off"
                      />
                      <div style={{ flexGrow: 1 }}>
                        <TextField
                          label="Settings override (JSON, optional)"
                          value={row.settingsJson}
                          onChange={(value) =>
                            updateVariantRow(index, "settingsJson", value)
                          }
                          autoComplete="off"
                        />
                      </div>
                      <Button
                        variant="plain"
                        tone="critical"
                        disabled={variantRows.length <= 1}
                        onClick={() =>
                          setVariantRows((rows) =>
                            rows.length > 1
                              ? rows.filter((_, i) => i !== index)
                              : rows,
                          )
                        }
                      >
                        Remove
                      </Button>
                    </InlineStack>
                  ))}
                  <InlineStack gap="200">
                    <Button
                      variant="plain"
                      onClick={() =>
                        setVariantRows((rows) => [
                          ...rows,
                          { ...EMPTY_VARIANT_ROW },
                        ])
                      }
                    >
                      Add variant
                    </Button>
                    <Button
                      variant="primary"
                      onClick={handleExperimentSave}
                      loading={isSubmitting}
                    >
                      {editingExperimentId ? "Save experiment" : "Create experiment"}
                    </Button>
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Assignments & telemetry
                </Text>
                <Text as="h3" variant="headingSm">
                  Experiment assignments
                </Text>
                {assignmentRows.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No assignments yet.
                  </Text>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "text", "numeric"]}
                    headings={["Experiment", "Variant", "Subjects"]}
                    rows={assignmentRows}
                  />
                )}
                <Divider />
                <Text as="h3" variant="headingSm">
                  Widget telemetry (last 1,000 events)
                </Text>
                {telemetryTableRows.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No widget events recorded yet.
                  </Text>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "text", "numeric"]}
                    headings={["Event", "Variant", "Count"]}
                    rows={telemetryTableRows}
                  />
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
