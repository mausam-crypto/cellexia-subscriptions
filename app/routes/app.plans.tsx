/**
 * Admin — Treatment plans (SellingPlanConfig).
 *
 * Lists versioned selling-plan configurations, provides a create/edit form
 * (plan rows, quantity→cadence defaults, activation), product assignment, and
 * version history. Pushing to Shopify and product assignment go through the
 * core contracts (pushSellingPlanConfig / assignProductsToConfig).
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
import type { AdminGraphql } from "~/services/core/shopifyClient.server";
import {
  assignProductsToConfig,
  pushSellingPlanConfig,
} from "~/services/core/sellingPlans.server";
import type { QuantityDefaultsShape } from "~/services/offers/widgets.server";
import {
  discountMonotonicityWarning,
  isCommittedPlan,
} from "~/services/offers/planWarnings";
import { parseJson } from "~/types/domain";

interface PlanDefinition {
  name: string;
  intervalWeeks: number;
  percentOff: number;
  shopifyPlanId?: string;
  /** Committed Treatment Plan: minimum deliveries (meaningful when >= 2). */
  minDeliveries?: number;
  /** Committed Treatment Plan marker. */
  committed?: boolean;
}

// Pure guard lives in the offers service (vitest-safe, no server imports);
// re-exported here so existing importers of the route keep working. The check
// runs separately for the committed and standard tracks — committed plans
// legitimately discount more than standard ones at the same interval.
export { discountMonotonicityWarning };

type ActionResponse = { ok: boolean; message?: string; error?: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireRole(session, "OWNER", "ADMIN");
  const configs = await prisma.sellingPlanConfig.findMany({
    where: { shop: session.shop },
    orderBy: { updatedAt: "desc" },
    include: {
      versions: {
        orderBy: { version: "desc" },
        take: 10,
        select: { id: true, version: true, changedBy: true, createdAt: true },
      },
    },
  });
  return json({ configs });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  await requireRole(session, "OWNER", "ADMIN");
  const graphql = admin.graphql as unknown as AdminGraphql;
  const staffId =
    session.onlineAccessInfo?.associated_user?.email ?? session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "save") {
      const configId = String(form.get("configId") ?? "").trim();
      const name = String(form.get("name") ?? "").trim();
      const merchantCode = String(form.get("merchantCode") ?? "").trim();
      const active = String(form.get("active") ?? "") === "true";
      if (!name || !merchantCode) {
        return json<ActionResponse>(
          { ok: false, error: "Name and merchant code are required." },
          { status: 400 },
        );
      }

      const rawPlans = parseJson<PlanDefinition[]>(
        String(form.get("plansJson") ?? "[]"),
        [],
      );
      const plans = rawPlans.filter(
        (p) =>
          p &&
          typeof p.name === "string" &&
          p.name.trim().length > 0 &&
          typeof p.intervalWeeks === "number" &&
          Number.isFinite(p.intervalWeeks) &&
          p.intervalWeeks >= 1 &&
          typeof p.percentOff === "number" &&
          Number.isFinite(p.percentOff) &&
          p.percentOff >= 0 &&
          p.percentOff < 100,
      );
      if (plans.length === 0) {
        return json<ActionResponse>(
          {
            ok: false,
            error:
              "At least one valid plan row is required (name, interval in weeks, discount %).",
          },
          { status: 400 },
        );
      }

      const qtyDefaults: Record<string, number> = {};
      for (const qty of ["1", "2", "3"]) {
        const weeks = Number.parseInt(
          String(form.get(`qty${qty}`) ?? "").trim(),
          10,
        );
        if (Number.isFinite(weeks) && weeks >= 1 && weeks <= 52) {
          qtyDefaults[qty] = weeks;
        }
      }

      const existing = configId
        ? await prisma.sellingPlanConfig.findFirst({
            where: { id: configId, shop: session.shop },
          })
        : null;
      if (configId && !existing) {
        return json<ActionResponse>(
          { ok: false, error: "Configuration not found." },
          { status: 404 },
        );
      }

      // Preserve per-product overrides; the form only edits the defaults.
      const previousDefaults = parseJson<QuantityDefaultsShape>(
        existing?.quantityDefaultsJson ?? null,
        {},
      );
      const quantityDefaultsJson = JSON.stringify({
        default: qtyDefaults,
        byProduct: previousDefaults.byProduct ?? {},
      });

      const data = {
        name,
        merchantCode,
        active,
        plansJson: JSON.stringify(
          plans.map((p) => ({
            name: p.name.trim(),
            intervalWeeks: Math.round(p.intervalWeeks),
            percentOff: p.percentOff,
            ...(typeof p.shopifyPlanId === "string" && p.shopifyPlanId
              ? { shopifyPlanId: p.shopifyPlanId }
              : {}),
            // Committed Treatment Plan fields (shared contract): a minimum of
            // >= 2 deliveries is pushed to Shopify as billingPolicy minCycles.
            ...(typeof p.minDeliveries === "number" &&
            Number.isFinite(p.minDeliveries) &&
            Math.round(p.minDeliveries) >= 2
              ? { minDeliveries: Math.round(p.minDeliveries) }
              : {}),
            ...(p.committed === true ? { committed: true } : {}),
          })),
        ),
        quantityDefaultsJson,
      };

      const saved = existing
        ? await prisma.sellingPlanConfig.update({
            where: { id: existing.id },
            data,
          })
        : await prisma.sellingPlanConfig.create({
            data: { ...data, shop: session.shop },
          });

      await appendAudit({
        shop: session.shop,
        actorType: "STAFF",
        actorId: staffId,
        action: existing
          ? "SELLING_PLAN_CONFIG_UPDATED"
          : "SELLING_PLAN_CONFIG_CREATED",
        subjectType: "SellingPlanConfig",
        subjectId: saved.id,
        payload: { name, merchantCode, active, plans, quantityDefaults: qtyDefaults },
      });

      // Core pushes to Shopify, bumps version and snapshots the config.
      await pushSellingPlanConfig(graphql, session.shop, saved.id);

      return json<ActionResponse>({
        ok: true,
        message:
          "Plan configuration saved and pushed to Shopify. Existing subscribers are not affected.",
      });
    }

    if (intent === "assign") {
      const configId = String(form.get("configId") ?? "").trim();
      const config = await prisma.sellingPlanConfig.findFirst({
        where: { id: configId, shop: session.shop },
      });
      if (!config) {
        return json<ActionResponse>(
          { ok: false, error: "Configuration not found." },
          { status: 404 },
        );
      }
      const productGids = String(form.get("productGids") ?? "")
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((g) =>
          g.startsWith("gid://") ? g : `gid://shopify/Product/${g}`,
        );
      if (productGids.length === 0) {
        return json<ActionResponse>(
          { ok: false, error: "Paste at least one product GID or numeric id." },
          { status: 400 },
        );
      }

      await assignProductsToConfig(graphql, session.shop, config.id, productGids);

      await appendAudit({
        shop: session.shop,
        actorType: "STAFF",
        actorId: staffId,
        action: "SELLING_PLAN_PRODUCTS_ASSIGNED",
        subjectType: "SellingPlanConfig",
        subjectId: config.id,
        payload: { productGids },
      });

      return json<ActionResponse>({
        ok: true,
        message: `${productGids.length} product(s) assigned to "${config.name}".`,
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
        error:
          error instanceof Error ? error.message : "Something went wrong.",
      },
      { status: 500 },
    );
  }
};

interface PlanRowState {
  name: string;
  intervalWeeks: string;
  percentOff: string;
  /** Commitment (min deliveries) — empty string means no commitment. */
  minDeliveries: string;
  /** Committed Treatment Plan marker. */
  committed: boolean;
  /** Present on rows loaded from a pushed config; keeps edits mapping to
   *  sellingPlansToUpdate instead of creating duplicate plans. */
  shopifyPlanId?: string;
}

const EMPTY_PLAN_ROW: PlanRowState = {
  name: "",
  intervalWeeks: "4",
  percentOff: "10",
  minDeliveries: "",
  committed: false,
};

export default function PlansPage() {
  const { configs } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const isSubmitting = navigation.state === "submitting";

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [merchantCode, setMerchantCode] = useState("");
  const [active, setActive] = useState(true);
  const [planRows, setPlanRows] = useState<PlanRowState[]>([
    { ...EMPTY_PLAN_ROW },
  ]);
  const [qty1, setQty1] = useState("4");
  const [qty2, setQty2] = useState("8");
  const [qty3, setQty3] = useState("12");

  const [assignConfigId, setAssignConfigId] = useState("");
  const [productGids, setProductGids] = useState("");

  const editingConfig = configs.find((c) => c.id === editingId) ?? null;

  const startNew = useCallback(() => {
    setEditingId(null);
    setName("");
    setMerchantCode("");
    setActive(true);
    setPlanRows([{ ...EMPTY_PLAN_ROW }]);
    setQty1("4");
    setQty2("8");
    setQty3("12");
  }, []);

  const startEdit = useCallback(
    (configId: string) => {
      const config = configs.find((c) => c.id === configId);
      if (!config) return;
      setEditingId(config.id);
      setName(config.name);
      setMerchantCode(config.merchantCode);
      setActive(config.active);
      const plans = parseJson<PlanDefinition[]>(config.plansJson, []);
      setPlanRows(
        plans.length > 0
          ? plans.map((p) => ({
              name: String(p.name ?? ""),
              intervalWeeks: String(p.intervalWeeks ?? "4"),
              percentOff: String(p.percentOff ?? "0"),
              minDeliveries:
                typeof p.minDeliveries === "number" ? String(p.minDeliveries) : "",
              committed: p.committed === true,
              shopifyPlanId:
                typeof p.shopifyPlanId === "string" ? p.shopifyPlanId : undefined,
            }))
          : [{ ...EMPTY_PLAN_ROW }],
      );
      const defaults = parseJson<QuantityDefaultsShape>(
        config.quantityDefaultsJson,
        {},
      );
      const map: Record<string, number> =
        defaults.default && typeof defaults.default === "object"
          ? defaults.default
          : {};
      setQty1(map["1"] ? String(map["1"]) : "");
      setQty2(map["2"] ? String(map["2"]) : "");
      setQty3(map["3"] ? String(map["3"]) : "");
    },
    [configs],
  );

  const updatePlanRow = useCallback(
    (index: number, field: keyof PlanRowState, value: string | boolean) => {
      setPlanRows((rows) =>
        rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
      );
    },
    [],
  );

  const handleSave = useCallback(() => {
    const formData = new FormData();
    formData.set("intent", "save");
    formData.set("configId", editingId ?? "");
    formData.set("name", name);
    formData.set("merchantCode", merchantCode);
    formData.set("active", active ? "true" : "false");
    formData.set(
      "plansJson",
      JSON.stringify(
        planRows.map((row) => {
          const minDeliveries = Number.parseInt(row.minDeliveries, 10);
          return {
            name: row.name,
            intervalWeeks: Number.parseInt(row.intervalWeeks, 10) || 0,
            percentOff: Number.parseFloat(row.percentOff) || 0,
            ...(row.shopifyPlanId ? { shopifyPlanId: row.shopifyPlanId } : {}),
            ...(Number.isInteger(minDeliveries) && minDeliveries >= 2
              ? { minDeliveries }
              : {}),
            ...(row.committed ? { committed: true } : {}),
          };
        }),
      ),
    );
    formData.set("qty1", qty1);
    formData.set("qty2", qty2);
    formData.set("qty3", qty3);
    submit(formData, { method: "post" });
  }, [editingId, name, merchantCode, active, planRows, qty1, qty2, qty3, submit]);

  const handleAssign = useCallback(() => {
    const formData = new FormData();
    formData.set("intent", "assign");
    formData.set("configId", assignConfigId);
    formData.set("productGids", productGids);
    submit(formData, { method: "post" });
  }, [assignConfigId, productGids, submit]);

  const configRows = configs.map((config) => {
    const plans = parseJson<PlanDefinition[]>(config.plansJson, []);
    return [
      config.name,
      config.merchantCode,
      `v${config.version}`,
      <InlineStack gap="100" wrap blockAlign="center" key={`${config.id}-plans`}>
        {plans.map((p, index) => (
          <InlineStack gap="100" blockAlign="center" key={index} wrap={false}>
            <Text as="span" variant="bodySm">
              {`${index > 0 ? "· " : ""}${p.name} (${p.intervalWeeks}w, -${p.percentOff}%)`}
            </Text>
            {isCommittedPlan(p) ? (
              <Badge tone="info" size="small">
                {`Committed${
                  typeof p.minDeliveries === "number"
                    ? ` · min ${p.minDeliveries}`
                    : ""
                }`}
              </Badge>
            ) : null}
          </InlineStack>
        ))}
      </InlineStack>,
      config.active ? (
        <Badge tone="success" key={`${config.id}-badge`}>
          Active
        </Badge>
      ) : (
        <Badge key={`${config.id}-badge`}>Inactive</Badge>
      ),
      <Button
        key={`${config.id}-edit`}
        onClick={() => startEdit(config.id)}
        variant="plain"
      >
        Edit
      </Button>,
    ];
  });

  const versionRows = (editingConfig?.versions ?? []).map((version) => [
    `v${version.version}`,
    version.changedBy,
    String(version.createdAt).slice(0, 10),
  ]);

  const discountWarnings = configs
    .filter((c) => c.active)
    .map((c) => ({
      name: c.name,
      warning: discountMonotonicityWarning(
        parseJson<PlanDefinition[]>(c.plansJson, []),
      ),
    }))
    .filter((w) => w.warning !== null);

  const configOptions = [
    { label: "Select a configuration…", value: "" },
    ...configs.map((c) => ({ label: `${c.name} (v${c.version})`, value: c.id })),
  ];

  return (
    <Page
      title="Treatment plans"
      subtitle="Selling plan configurations, cadence defaults and product assignment"
      primaryAction={{ content: "New configuration", onAction: startNew }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner
              title="Editing plans never changes existing subscribers"
              tone="info"
            >
              <p>
                A treatment plan becomes independent of its selling plan at
                purchase. Changes here only affect new sign-ups — every
                existing contract keeps the rules it was created under (each
                cohort's rules are preserved in the version history below).
              </p>
            </Banner>

            {actionData?.error ? (
              <Banner title={actionData.error} tone="critical" />
            ) : null}
            {actionData?.message ? (
              <Banner title={actionData.message} tone="success" />
            ) : null}

            {discountWarnings.map((w) => (
              <Banner
                key={w.name}
                title={`"${w.name}": more units would cost more per unit`}
                tone="warning"
              >
                <p>{w.warning}</p>
              </Banner>
            ))}

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Configurations
                </Text>
                {configs.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No plan configurations yet. Create one to offer Continuous
                    Treatment on your products.
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
                    ]}
                    headings={[
                      "Name",
                      "Merchant code",
                      "Version",
                      "Plans",
                      "Status",
                      "",
                    ]}
                    rows={configRows}
                  />
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  {editingConfig
                    ? `Edit "${editingConfig.name}" (v${editingConfig.version})`
                    : "New configuration"}
                </Text>
                <FormLayout>
                  <FormLayout.Group>
                    <TextField
                      label="Name"
                      value={name}
                      onChange={setName}
                      autoComplete="off"
                      helpText="Shown in Shopify admin, not to customers."
                    />
                    <TextField
                      label="Merchant code"
                      value={merchantCode}
                      onChange={setMerchantCode}
                      autoComplete="off"
                      helpText="Internal identifier for the selling plan group."
                    />
                  </FormLayout.Group>
                  <Checkbox
                    label="Active"
                    checked={active}
                    onChange={setActive}
                  />
                </FormLayout>

                <Divider />

                <Text as="h3" variant="headingSm">
                  Plans
                </Text>
                <BlockStack gap="200">
                  {planRows.map((row, index) => (
                    <InlineStack gap="200" blockAlign="end" key={index} wrap={false}>
                      <div style={{ flexGrow: 1 }}>
                        <TextField
                          label="Plan name"
                          value={row.name}
                          onChange={(value) =>
                            updatePlanRow(index, "name", value)
                          }
                          autoComplete="off"
                          placeholder="Every 4 weeks"
                        />
                      </div>
                      <TextField
                        label="Interval (weeks)"
                        type="number"
                        value={row.intervalWeeks}
                        onChange={(value) =>
                          updatePlanRow(index, "intervalWeeks", value)
                        }
                        autoComplete="off"
                      />
                      <TextField
                        label="Discount (%)"
                        type="number"
                        value={row.percentOff}
                        onChange={(value) =>
                          updatePlanRow(index, "percentOff", value)
                        }
                        autoComplete="off"
                      />
                      <TextField
                        label="Commitment (min deliveries)"
                        type="number"
                        min={2}
                        value={row.minDeliveries}
                        onChange={(value) =>
                          updatePlanRow(index, "minDeliveries", value)
                        }
                        autoComplete="off"
                        placeholder="e.g. 3"
                      />
                      <Checkbox
                        label="Committed plan"
                        checked={row.committed}
                        onChange={(checked) =>
                          updatePlanRow(index, "committed", checked)
                        }
                      />
                      <Button
                        onClick={() =>
                          setPlanRows((rows) =>
                            rows.length > 1
                              ? rows.filter((_, i) => i !== index)
                              : rows,
                          )
                        }
                        tone="critical"
                        variant="plain"
                        disabled={planRows.length <= 1}
                      >
                        Remove
                      </Button>
                    </InlineStack>
                  ))}
                  <InlineStack>
                    <Button
                      onClick={() =>
                        setPlanRows((rows) => [...rows, { ...EMPTY_PLAN_ROW }])
                      }
                      variant="plain"
                    >
                      Add plan row
                    </Button>
                  </InlineStack>
                </BlockStack>

                <Divider />

                <Text as="h3" variant="headingSm">
                  Quantity → cadence defaults
                </Text>
                <Text as="p" tone="subdued">
                  Default delivery rhythm suggested by widget B for each
                  quantity (in weeks). Per-product overrides are preserved and
                  managed separately.
                </Text>
                <FormLayout>
                  <FormLayout.Group condensed>
                    <TextField
                      label="Quantity 1 — every (weeks)"
                      type="number"
                      value={qty1}
                      onChange={setQty1}
                      autoComplete="off"
                    />
                    <TextField
                      label="Quantity 2 — every (weeks)"
                      type="number"
                      value={qty2}
                      onChange={setQty2}
                      autoComplete="off"
                    />
                    <TextField
                      label="Quantity 3 — every (weeks)"
                      type="number"
                      value={qty3}
                      onChange={setQty3}
                      autoComplete="off"
                    />
                  </FormLayout.Group>
                </FormLayout>

                <InlineStack gap="200">
                  <Button
                    variant="primary"
                    onClick={handleSave}
                    loading={isSubmitting}
                  >
                    {editingConfig
                      ? "Save & push to Shopify"
                      : "Create & push to Shopify"}
                  </Button>
                  {editingConfig ? (
                    <Button onClick={startNew} variant="plain">
                      Cancel editing
                    </Button>
                  ) : null}
                </InlineStack>
              </BlockStack>
            </Card>

            {editingConfig && versionRows.length > 0 ? (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Version history — {editingConfig.name}
                  </Text>
                  <Text as="p" tone="subdued">
                    Every push snapshots the full rule set, so you always know
                    which rules each subscriber cohort signed up under.
                  </Text>
                  <DataTable
                    columnContentTypes={["text", "text", "text"]}
                    headings={["Version", "Changed by", "Date"]}
                    rows={versionRows}
                  />
                </BlockStack>
              </Card>
            ) : null}

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Assign products
                </Text>
                <Select
                  label="Configuration"
                  options={configOptions}
                  value={assignConfigId}
                  onChange={setAssignConfigId}
                />
                <TextField
                  label="Product GIDs"
                  value={productGids}
                  onChange={setProductGids}
                  autoComplete="off"
                  multiline={4}
                  placeholder={"gid://shopify/Product/1234567890\ngid://shopify/Product/0987654321"}
                  helpText="One per line (or comma-separated). Bare numeric ids are accepted and converted to GIDs."
                />
                <InlineStack>
                  <Button
                    onClick={handleAssign}
                    loading={isSubmitting}
                    disabled={!assignConfigId || productGids.trim().length === 0}
                  >
                    Assign products
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
