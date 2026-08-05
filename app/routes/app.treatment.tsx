/**
 * Treatment engine admin — [treatment] module.
 *
 * Tabs: Products (ProductMeta editor), Compatibility (edge list + add form),
 * Routines (RoutineTemplate CRUD), Adherence (survey responses), Depletion
 * (estimates + staff override → SURVEY_OVERRIDE signal), Milestones (recent
 * milestones + reward configuration).
 */
import { useState } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  SerializeFrom,
} from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useSubmit } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  DataTable,
  FormLayout,
  InlineStack,
  Page,
  Select,
  Tabs,
  Text,
  TextField,
} from "@shopify/polaris";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { appendAudit } from "~/services/audit.server";
import { requireRole } from "~/services/core/rbac.server";
import { registerDepletionSignal } from "~/services/treatment/depletion.server";
import { deleteEdge, upsertEdge } from "~/services/treatment/compatibility.server";
import { DEFAULT_MILESTONE_REWARDS } from "~/services/treatment/milestones.server";
import { getModelState } from "~/services/analytics/learning.server";
import type { DepletionUsageParams } from "~/services/analytics/learning.server";
import { COMPATIBILITY_RELATIONS, TIME_OF_DAY, parseJson } from "~/types/domain";
import type { CompatibilityRelation } from "~/types/domain";

// ─────────────────────────────── Loader ───────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireRole(session, "OWNER", "ADMIN");
  const shop = session.shop;
  const [
    products,
    edges,
    routines,
    surveys,
    estimates,
    milestones,
    settings,
    usageModel,
  ] = await Promise.all([
      prisma.productMeta.findMany({ where: { shop }, orderBy: { title: "asc" } }),
      prisma.compatibilityEdge.findMany({
        where: { shop },
        orderBy: { createdAt: "desc" },
      }),
      prisma.routineTemplate.findMany({
        where: { shop, active: true },
        orderBy: { updatedAt: "desc" },
      }),
      prisma.adherenceSurvey.findMany({
        where: { shop },
        orderBy: { sentAt: "desc" },
        take: 50,
      }),
      prisma.depletionEstimate.findMany({
        where: { line: { contract: { shop } } },
        include: {
          line: {
            include: {
              contract: {
                select: {
                  id: true,
                  customerEmail: true,
                  nextDeliveryDate: true,
                  nextBillingDate: true,
                },
              },
            },
          },
        },
        orderBy: { updatedAt: "desc" },
        take: 100,
      }),
      prisma.milestone.findMany({
        where: { contract: { shop } },
        include: { contract: { select: { customerEmail: true } } },
        orderBy: { achievedAt: "desc" },
        take: 50,
      }),
      prisma.shopSettings.findUnique({ where: { shop } }),
      getModelState(shop, "DEPLETION_USAGE"),
    ]);

  const settingsJson = parseJson<Record<string, unknown>>(
    settings?.settingsJson,
    {},
  );
  const milestoneRewards = {
    ...DEFAULT_MILESTONE_REWARDS,
    ...((settingsJson.milestoneRewards as Record<string, unknown> | undefined) ??
      {}),
  };

  // Learned DEPLETION_USAGE suggestions (LEARNING-DATA-V2 §1): read-only
  // hints rendered beside each product's daily-usage field — the depletion
  // engine itself stays on the merchant-configured value.
  const usageParams = (usageModel?.params ?? null) as DepletionUsageParams | null;
  const usageSuggestions: Record<
    string,
    { multiplier: number; n: number; suggestedDailyUsage: number | null }
  > = {};
  if (usageParams?.products) {
    for (const product of products) {
      const suggestion = usageParams.products[product.shopifyProductId];
      if (!suggestion || typeof suggestion.multiplier !== "number") continue;
      usageSuggestions[product.shopifyProductId] = {
        multiplier: suggestion.multiplier,
        n: typeof suggestion.n === "number" ? suggestion.n : 0,
        suggestedDailyUsage:
          product.defaultDailyUsage != null
            ? Math.round(product.defaultDailyUsage * suggestion.multiplier * 100) /
              100
            : null,
      };
    }
  }

  return json({
    products,
    edges,
    routines,
    surveys,
    estimates,
    milestones,
    milestoneRewards,
    usageSuggestions,
  });
};

type LoaderData = SerializeFrom<typeof loader>;

// ─────────────────────────────── Action ───────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireRole(session, "OWNER", "ADMIN");
  const shop = session.shop;
  const staff = session.onlineAccessInfo?.associated_user?.email ?? shop;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const str = (key: string): string => {
    const v = form.get(key);
    return v == null ? "" : String(v);
  };
  const num = (key: string): number | null => {
    const v = str(key).trim();
    if (v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  try {
    switch (intent) {
      case "save-product": {
        const shopifyProductId = str("shopifyProductId");
        if (!shopifyProductId) {
          return json(
            { ok: false, message: "A Shopify product id is required." },
            { status: 400 },
          );
        }
        const timeOfDayRaw = str("timeOfDay");
        const unitCost = num("unitCostCents");
        const heroRank = num("heroRank");
        // grossMarginPercent is a FRACTION 0..1 by schema; a percent-style
        // entry like "72" would be silently clamped to 100% margin downstream
        // and inflate every profit figure — reject it explicitly instead.
        const margin = num("grossMarginPercent");
        if (margin != null && (margin <= 0 || margin > 1)) {
          return json(
            {
              ok: false,
              message:
                "Gross margin must be a fraction between 0 and 1 (e.g. 0.72 for 72%).",
            },
            { status: 400 },
          );
        }
        const data = {
          title: str("title") || shopifyProductId,
          unitContents: num("unitContents"),
          defaultDailyUsage: num("defaultDailyUsage"),
          grossMarginPercent: margin,
          unitCostCents: unitCost == null ? null : Math.round(unitCost),
          timeOfDay: (TIME_OF_DAY as readonly string[]).includes(timeOfDayRaw)
            ? timeOfDayRaw
            : "BOTH",
          concern: str("concern") || null,
          heroRank: heroRank == null ? null : Math.round(heroRank),
          subscribable: str("subscribable") === "true",
        };
        await prisma.productMeta.upsert({
          where: { shop_shopifyProductId: { shop, shopifyProductId } },
          create: { shop, shopifyProductId, ...data },
          update: data,
        });
        await appendAudit({
          shop,
          actorType: "STAFF",
          actorId: staff,
          action: "PRODUCT_META_SAVED",
          subjectType: "ProductMeta",
          subjectId: shopifyProductId,
          payload: { ...data },
        });
        return json({ ok: true, message: "Product treatment settings saved." });
      }

      case "add-edge": {
        const relation = str("relation") as CompatibilityRelation;
        await upsertEdge(
          shop,
          {
            fromProductId: str("fromProductId"),
            toProductId: str("toProductId"),
            relation,
            strength: num("strength") ?? 1,
            notes: str("notes") || null,
          },
          staff,
        );
        return json({ ok: true, message: "Compatibility relation saved." });
      }

      case "delete-edge": {
        await deleteEdge(shop, str("edgeId"), staff);
        return json({ ok: true, message: "Compatibility relation removed." });
      }

      case "save-routine": {
        const routineId = str("routineId");
        let steps: unknown;
        try {
          steps = JSON.parse(str("stepsJson"));
        } catch {
          return json(
            { ok: false, message: "Steps must be valid JSON." },
            { status: 400 },
          );
        }
        if (
          !Array.isArray(steps) ||
          steps.some(
            (s) =>
              typeof s !== "object" ||
              s === null ||
              typeof (s as { productId?: unknown }).productId !== "string",
          )
        ) {
          return json(
            {
              ok: false,
              message:
                "Steps must be a JSON array of {productId, role, timeOfDay, optional}.",
            },
            { status: 400 },
          );
        }
        const data = {
          name: str("name"),
          concern: str("concern"),
          description: str("description") || null,
          stepsJson: JSON.stringify(steps),
        };
        if (!data.name || !data.concern) {
          return json(
            { ok: false, message: "Name and concern are required." },
            { status: 400 },
          );
        }
        let savedId: string;
        if (routineId) {
          const existing = await prisma.routineTemplate.findUnique({
            where: { id: routineId },
          });
          if (!existing || existing.shop !== shop) {
            return json({ ok: false, message: "Routine not found." }, { status: 404 });
          }
          await prisma.routineTemplate.update({ where: { id: routineId }, data });
          savedId = routineId;
        } else {
          const created = await prisma.routineTemplate.create({
            data: { shop, ...data },
          });
          savedId = created.id;
        }
        await appendAudit({
          shop,
          actorType: "STAFF",
          actorId: staff,
          action: "ROUTINE_TEMPLATE_SAVED",
          subjectType: "RoutineTemplate",
          subjectId: savedId,
          payload: { ...data },
        });
        return json({ ok: true, message: "Routine saved." });
      }

      case "delete-routine": {
        const routineId = str("routineId");
        const existing = await prisma.routineTemplate.findUnique({
          where: { id: routineId },
        });
        if (!existing || existing.shop !== shop) {
          return json({ ok: false, message: "Routine not found." }, { status: 404 });
        }
        await prisma.routineTemplate.update({
          where: { id: routineId },
          data: { active: false },
        });
        await appendAudit({
          shop,
          actorType: "STAFF",
          actorId: staff,
          action: "ROUTINE_TEMPLATE_ARCHIVED",
          subjectType: "RoutineTemplate",
          subjectId: routineId,
          payload: {},
        });
        return json({ ok: true, message: "Routine archived." });
      }

      case "override-depletion": {
        const lineId = str("lineId");
        const units = num("unitsRemaining");
        if (units == null || units < 0) {
          return json(
            { ok: false, message: "Enter the remaining amount as a number ≥ 0." },
            { status: 400 },
          );
        }
        await registerDepletionSignal(shop, lineId, "SURVEY_OVERRIDE", {
          reportedUnitsRemaining: units,
        });
        await appendAudit({
          shop,
          actorType: "STAFF",
          actorId: staff,
          action: "DEPLETION_OVERRIDE",
          subjectType: "ContractLine",
          subjectId: lineId,
          payload: { unitsRemaining: units },
        });
        return json({
          ok: true,
          message: "Estimate updated from the reported amount.",
        });
      }

      case "save-milestone-rewards": {
        let rewards: unknown;
        try {
          rewards = JSON.parse(str("rewardsJson"));
        } catch {
          return json(
            { ok: false, message: "Rewards must be valid JSON." },
            { status: 400 },
          );
        }
        if (typeof rewards !== "object" || rewards === null || Array.isArray(rewards)) {
          return json(
            {
              ok: false,
              message: "Rewards must be a JSON object keyed by milestone type.",
            },
            { status: 400 },
          );
        }
        const settings = await prisma.shopSettings.findUnique({ where: { shop } });
        const settingsJson = parseJson<Record<string, unknown>>(
          settings?.settingsJson,
          {},
        );
        settingsJson.milestoneRewards = rewards;
        await prisma.shopSettings.upsert({
          where: { shop },
          create: { shop, settingsJson: JSON.stringify(settingsJson) },
          update: { settingsJson: JSON.stringify(settingsJson) },
        });
        await appendAudit({
          shop,
          actorType: "STAFF",
          actorId: staff,
          action: "MILESTONE_REWARDS_SAVED",
          subjectType: "ShopSettings",
          subjectId: shop,
          payload: { rewards },
        });
        return json({ ok: true, message: "Milestone rewards saved." });
      }

      default:
        return json(
          { ok: false, message: `Unknown action: ${intent}` },
          { status: 400 },
        );
    }
  } catch (e) {
    return json(
      { ok: false, message: e instanceof Error ? e.message : "Something went wrong." },
      { status: 400 },
    );
  }
};

// ─────────────────────────────── UI ───────────────────────────────────────

export default function TreatmentPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [tab, setTab] = useState(0);
  const tabs = [
    { id: "products", content: "Products" },
    { id: "compatibility", content: "Compatibility" },
    { id: "routines", content: "Routines" },
    { id: "adherence", content: "Adherence" },
    { id: "depletion", content: "Depletion" },
    { id: "milestones", content: "Milestones" },
  ];

  return (
    <Page
      title="Treatment engine"
      subtitle="Depletion, routines, adherence and milestones behind continuous treatment plans"
    >
      <BlockStack gap="400">
        {actionData ? (
          <Banner tone={actionData.ok ? "success" : "critical"}>
            {actionData.message}
          </Banner>
        ) : null}
        <Tabs tabs={tabs} selected={tab} onSelect={setTab} />
        {tab === 0 && (
          <ProductsTab
            products={data.products}
            usageSuggestions={data.usageSuggestions}
          />
        )}
        {tab === 1 && <CompatibilityTab edges={data.edges} products={data.products} />}
        {tab === 2 && <RoutinesTab routines={data.routines} />}
        {tab === 3 && <AdherenceTab surveys={data.surveys} />}
        {tab === 4 && <DepletionTab estimates={data.estimates} />}
        {tab === 5 && (
          <MilestonesTab
            milestones={data.milestones}
            milestoneRewards={data.milestoneRewards}
          />
        )}
      </BlockStack>
    </Page>
  );
}

// ─────────────────────────────── Products ─────────────────────────────────

type ProductRow = LoaderData["products"][number];
type UsageSuggestion = LoaderData["usageSuggestions"][string];

function ProductsTab({
  products,
  usageSuggestions,
}: {
  products: ProductRow[];
  usageSuggestions: LoaderData["usageSuggestions"];
}) {
  return (
    <BlockStack gap="400">
      <AddProductForm />
      {products.length === 0 ? (
        <Card>
          <Text as="p" tone="subdued">
            No products yet. Products sync automatically from Shopify; you can
            also add one above to set its treatment metadata.
          </Text>
        </Card>
      ) : (
        products.map((product) => (
          <ProductMetaEditor
            key={product.id}
            product={product}
            usageSuggestion={usageSuggestions[product.shopifyProductId] ?? null}
          />
        ))
      )}
    </BlockStack>
  );
}

function AddProductForm() {
  const submit = useSubmit();
  const [productId, setProductId] = useState("");
  const [title, setTitle] = useState("");
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingMd">
          Add product metadata
        </Text>
        <FormLayout>
          <FormLayout.Group>
            <TextField
              label="Shopify product id (GID)"
              value={productId}
              onChange={setProductId}
              autoComplete="off"
              placeholder="gid://shopify/Product/123"
            />
            <TextField
              label="Title"
              value={title}
              onChange={setTitle}
              autoComplete="off"
            />
          </FormLayout.Group>
        </FormLayout>
        <InlineStack align="end">
          <Button
            onClick={() =>
              submit(
                {
                  intent: "save-product",
                  shopifyProductId: productId,
                  title,
                  subscribable: "true",
                  timeOfDay: "BOTH",
                },
                { method: "post" },
              )
            }
            disabled={!productId}
          >
            Add product
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

function ProductMetaEditor({
  product,
  usageSuggestion = null,
}: {
  product: ProductRow;
  /** Learned daily-usage hint from the DEPLETION_USAGE model (read-only). */
  usageSuggestion?: UsageSuggestion | null;
}) {
  const submit = useSubmit();
  const [unitContents, setUnitContents] = useState(
    product.unitContents?.toString() ?? "",
  );
  const [dailyUsage, setDailyUsage] = useState(
    product.defaultDailyUsage?.toString() ?? "",
  );
  const [margin, setMargin] = useState(product.grossMarginPercent?.toString() ?? "");
  const [unitCost, setUnitCost] = useState(product.unitCostCents?.toString() ?? "");
  const [timeOfDay, setTimeOfDay] = useState(product.timeOfDay);
  const [concern, setConcern] = useState(product.concern ?? "");
  const [heroRank, setHeroRank] = useState(product.heroRank?.toString() ?? "");
  const [subscribable, setSubscribable] = useState(product.subscribable);

  const save = () =>
    submit(
      {
        intent: "save-product",
        shopifyProductId: product.shopifyProductId,
        title: product.title,
        unitContents,
        defaultDailyUsage: dailyUsage,
        grossMarginPercent: margin,
        unitCostCents: unitCost,
        timeOfDay,
        concern,
        heroRank,
        subscribable: subscribable ? "true" : "false",
      },
      { method: "post" },
    );

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h3" variant="headingMd">
            {product.title}
          </Text>
          <Badge tone={product.subscribable ? "success" : "critical"}>
            {product.subscribable ? "On treatment plans" : "Not subscribable"}
          </Badge>
        </InlineStack>
        <FormLayout>
          <FormLayout.Group>
            <TextField
              label="Unit contents (ml/g)"
              type="number"
              value={unitContents}
              onChange={setUnitContents}
              autoComplete="off"
              helpText="Contents of one unit — drives the depletion engine."
            />
            <TextField
              label="Default daily usage (ml/g per day)"
              type="number"
              value={dailyUsage}
              onChange={setDailyUsage}
              autoComplete="off"
              helpText={
                usageSuggestion?.suggestedDailyUsage != null
                  ? `Observed usage across ${usageSuggestion.n} deliveries suggests ~${usageSuggestion.suggestedDailyUsage} per day — update if that matches reality.`
                  : undefined
              }
            />
          </FormLayout.Group>
          <FormLayout.Group>
            <TextField
              label="Gross margin (fraction, e.g. 0.72)"
              type="number"
              value={margin}
              onChange={setMargin}
              autoComplete="off"
              min={0}
              max={1}
              step={0.01}
              helpText="A fraction between 0 and 1 — enter 0.72 for a 72% margin, never 72."
            />
            <TextField
              label="Unit cost (cents)"
              type="number"
              value={unitCost}
              onChange={setUnitCost}
              autoComplete="off"
            />
          </FormLayout.Group>
          <FormLayout.Group>
            <Select
              label="Time of day"
              options={TIME_OF_DAY.map((t) => ({ label: t, value: t }))}
              value={timeOfDay}
              onChange={setTimeOfDay}
            />
            <TextField
              label="Primary concern"
              value={concern}
              onChange={setConcern}
              autoComplete="off"
              placeholder="hydration"
            />
            <TextField
              label="Hero rank"
              type="number"
              value={heroRank}
              onChange={setHeroRank}
              autoComplete="off"
              helpText="1 = hero treatment for graduated routine expansion."
            />
          </FormLayout.Group>
          <Checkbox
            label="Available on treatment plans"
            checked={subscribable}
            onChange={setSubscribable}
          />
        </FormLayout>
        <InlineStack align="end">
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

// ─────────────────────────────── Compatibility ────────────────────────────

type EdgeRow = LoaderData["edges"][number];

function CompatibilityTab({
  edges,
  products,
}: {
  edges: EdgeRow[];
  products: ProductRow[];
}) {
  const submit = useSubmit();
  const titleFor = (id: string) =>
    products.find((p) => p.shopifyProductId === id)?.title ?? id;

  return (
    <BlockStack gap="400">
      <AddEdgeForm products={products} />
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">
            Compatibility relations
          </Text>
          {edges.length === 0 ? (
            <Text as="p" tone="subdued">
              No relations yet. Add PAIRS_WITH, STAGGER, REDUNDANT,
              ROUTINE_STEP_BEFORE or SENSITIVITY_CONFLICT edges above.
            </Text>
          ) : (
            <DataTable
              columnContentTypes={["text", "text", "text", "numeric", "text"]}
              headings={["From", "Relation", "To", "Strength", ""]}
              rows={edges.map((edge) => [
                titleFor(edge.fromProductId),
                edge.relation,
                titleFor(edge.toProductId),
                edge.strength,
                <Button
                  key={edge.id}
                  tone="critical"
                  variant="plain"
                  onClick={() =>
                    submit(
                      { intent: "delete-edge", edgeId: edge.id },
                      { method: "post" },
                    )
                  }
                >
                  Remove
                </Button>,
              ])}
            />
          )}
        </BlockStack>
      </Card>
    </BlockStack>
  );
}

function AddEdgeForm({ products }: { products: ProductRow[] }) {
  const submit = useSubmit();
  const options = products.map((p) => ({
    label: p.title,
    value: p.shopifyProductId,
  }));
  const [from, setFrom] = useState(options[0]?.value ?? "");
  const [to, setTo] = useState(options[1]?.value ?? options[0]?.value ?? "");
  const [relation, setRelation] = useState<string>(COMPATIBILITY_RELATIONS[0]);
  const [strength, setStrength] = useState("1");
  const [notes, setNotes] = useState("");

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingMd">
          Add relation
        </Text>
        <FormLayout>
          <FormLayout.Group>
            <Select label="From product" options={options} value={from} onChange={setFrom} />
            <Select
              label="Relation"
              options={COMPATIBILITY_RELATIONS.map((r) => ({ label: r, value: r }))}
              value={relation}
              onChange={setRelation}
            />
            <Select label="To product" options={options} value={to} onChange={setTo} />
          </FormLayout.Group>
          <FormLayout.Group>
            <TextField
              label="Strength (0–1)"
              type="number"
              value={strength}
              onChange={setStrength}
              autoComplete="off"
            />
            <TextField
              label="Notes"
              value={notes}
              onChange={setNotes}
              autoComplete="off"
            />
          </FormLayout.Group>
        </FormLayout>
        <InlineStack align="end">
          <Button
            variant="primary"
            disabled={!from || !to || from === to}
            onClick={() =>
              submit(
                {
                  intent: "add-edge",
                  fromProductId: from,
                  toProductId: to,
                  relation,
                  strength,
                  notes,
                },
                { method: "post" },
              )
            }
          >
            Save relation
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

// ─────────────────────────────── Routines ─────────────────────────────────

type RoutineRow = LoaderData["routines"][number];

function RoutinesTab({ routines }: { routines: RoutineRow[] }) {
  return (
    <BlockStack gap="400">
      <RoutineEditor key="new" routine={null} />
      {routines.map((routine) => (
        <RoutineEditor key={routine.id} routine={routine} />
      ))}
    </BlockStack>
  );
}

function RoutineEditor({ routine }: { routine: RoutineRow | null }) {
  const submit = useSubmit();
  const [name, setName] = useState(routine?.name ?? "");
  const [concern, setConcern] = useState(routine?.concern ?? "");
  const [description, setDescription] = useState(routine?.description ?? "");
  const [steps, setSteps] = useState(() => {
    if (!routine) {
      return JSON.stringify(
        [{ productId: "gid://shopify/Product/…", role: "cleanser", timeOfDay: "BOTH", optional: false }],
        null,
        2,
      );
    }
    try {
      return JSON.stringify(JSON.parse(routine.stepsJson), null, 2);
    } catch {
      return routine.stepsJson;
    }
  });

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingMd">
          {routine ? routine.name : "New routine template"}
        </Text>
        <FormLayout>
          <FormLayout.Group>
            <TextField label="Name" value={name} onChange={setName} autoComplete="off" />
            <TextField
              label="Concern"
              value={concern}
              onChange={setConcern}
              autoComplete="off"
              placeholder="hydration"
            />
          </FormLayout.Group>
          <TextField
            label="Description"
            value={description}
            onChange={setDescription}
            autoComplete="off"
          />
          <TextField
            label="Ordered steps (JSON)"
            value={steps}
            onChange={setSteps}
            autoComplete="off"
            multiline={6}
            monospaced
            helpText='Array of {"productId", "role", "timeOfDay", "optional"} in application order.'
          />
        </FormLayout>
        <InlineStack align="end" gap="200">
          {routine ? (
            <Button
              tone="critical"
              variant="plain"
              onClick={() =>
                submit(
                  { intent: "delete-routine", routineId: routine.id },
                  { method: "post" },
                )
              }
            >
              Archive
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={!name || !concern}
            onClick={() =>
              submit(
                {
                  intent: "save-routine",
                  routineId: routine?.id ?? "",
                  name,
                  concern,
                  description,
                  stepsJson: steps,
                },
                { method: "post" },
              )
            }
          >
            {routine ? "Save" : "Create routine"}
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

// ─────────────────────────────── Adherence ────────────────────────────────

type SurveyRow = LoaderData["surveys"][number];

function AdherenceTab({ surveys }: { surveys: SurveyRow[] }) {
  const summarize = (answersJson: string): string => {
    const answers = parseJson<Record<string, string>>(answersJson, {});
    const parts = Object.entries(answers).map(([q, a]) => `${q}: ${a}`);
    if (parts.length === 0) return "—";
    const text = parts.join(" · ");
    return text.length > 140 ? `${text.slice(0, 137)}…` : text;
  };

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingMd">
          Recent survey responses
        </Text>
        {surveys.length === 0 ? (
          <Text as="p" tone="subdued">
            No surveys yet. Check-ins are sent automatically a few days after
            each completed delivery.
          </Text>
        ) : (
          <DataTable
            columnContentTypes={["text", "text", "text", "text"]}
            headings={["Sent", "Responded", "Contract", "Answers"]}
            rows={surveys.map((survey) => [
              survey.sentAt.slice(0, 10),
              survey.respondedAt ? survey.respondedAt.slice(0, 10) : "—",
              survey.contractId,
              summarize(survey.answersJson),
            ])}
          />
        )}
      </BlockStack>
    </Card>
  );
}

// ─────────────────────────────── Depletion ────────────────────────────────

type EstimateRow = LoaderData["estimates"][number];

function DepletionTab({ estimates }: { estimates: EstimateRow[] }) {
  return (
    <BlockStack gap="400">
      <Banner tone="info">
        Estimates are informational — they power nudges, incentives and
        dashboards, and never change a customer&apos;s delivery schedule
        automatically.
      </Banner>
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">
            Depletion estimates
          </Text>
          {estimates.length === 0 ? (
            <Text as="p" tone="subdued">
              No estimates yet. Estimates build up from deliveries, delays,
              skips and survey answers.
            </Text>
          ) : (
            <DataTable
              columnContentTypes={["text", "text", "numeric", "numeric", "text", "text", "text"]}
              headings={[
                "Product",
                "Customer",
                "Daily usage",
                "On hand",
                "Confidence",
                "Predicted run-out",
                "Override (units remaining)",
              ]}
              rows={estimates.map((estimate) => [
                estimate.line.title,
                estimate.line.contract.customerEmail ?? estimate.line.contract.id,
                estimate.estimatedDailyUsage.toFixed(2),
                estimate.unitsOnHand != null ? estimate.unitsOnHand.toFixed(1) : "—",
                `${Math.round(estimate.confidence * 100)}%`,
                estimate.predictedRunOutAt
                  ? estimate.predictedRunOutAt.slice(0, 10)
                  : "—",
                <DepletionOverride key={estimate.id} lineId={estimate.contractLineId} />,
              ])}
            />
          )}
        </BlockStack>
      </Card>
    </BlockStack>
  );
}

function DepletionOverride({ lineId }: { lineId: string }) {
  const submit = useSubmit();
  const [units, setUnits] = useState("");
  return (
    <InlineStack gap="200" blockAlign="center" wrap={false}>
      <TextField
        label="Units remaining"
        labelHidden
        type="number"
        value={units}
        onChange={setUnits}
        autoComplete="off"
        placeholder="ml/g left"
      />
      <Button
        size="slim"
        disabled={units.trim() === ""}
        onClick={() =>
          submit(
            { intent: "override-depletion", lineId, unitsRemaining: units },
            { method: "post" },
          )
        }
      >
        Apply
      </Button>
    </InlineStack>
  );
}

// ─────────────────────────────── Milestones ───────────────────────────────

type MilestoneRow = LoaderData["milestones"][number];

function MilestonesTab({
  milestones,
  milestoneRewards,
}: {
  milestones: MilestoneRow[];
  milestoneRewards: Record<string, unknown>;
}) {
  const submit = useSubmit();
  const [rewardsJson, setRewardsJson] = useState(() =>
    JSON.stringify(milestoneRewards, null, 2),
  );

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">
            Recent milestones
          </Text>
          {milestones.length === 0 ? (
            <Text as="p" tone="subdued">
              No milestones yet. Milestones are detected automatically as
              treatment plans mature.
            </Text>
          ) : (
            <DataTable
              columnContentTypes={["text", "text", "text", "text"]}
              headings={["Achieved", "Milestone", "Customer", "Reward status"]}
              rows={milestones.map((milestone) => [
                milestone.achievedAt.slice(0, 10),
                milestone.type,
                milestone.contract.customerEmail ?? milestone.contractId,
                milestone.rewardStatus,
              ])}
            />
          )}
        </BlockStack>
      </Card>
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">
            Reward configuration
          </Text>
          <Text as="p" tone="subdued">
            Rewards are accumulating benefits (free delivery, price protection,
            early access, replacement cover) — never countdowns or pressure.
          </Text>
          <TextField
            label="Milestone rewards (JSON)"
            labelHidden
            value={rewardsJson}
            onChange={setRewardsJson}
            autoComplete="off"
            multiline={12}
            monospaced
          />
          <InlineStack align="end">
            <Button
              variant="primary"
              onClick={() =>
                submit(
                  { intent: "save-milestone-rewards", rewardsJson },
                  { method: "post" },
                )
              }
            >
              Save rewards
            </Button>
          </InlineStack>
        </BlockStack>
      </Card>
    </BlockStack>
  );
}
