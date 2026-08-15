import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "@remix-run/react";
import { useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  DataTable,
  Divider,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { getSetting, setSetting } from "~/lib/settings/settings.server";
import { logEvent } from "~/lib/events/log.server";
import { formatMoney } from "~/lib/money";
import { EXPERIMENTS, experimentByKey } from "~/lib/experiments/index.server";

/**
 * Admin — Experiments.
 *
 * The readout for the deterministic customer-level test groups
 * (app/lib/experiments/index.server.ts). Populations come EXCLUSIVELY from
 * ExperimentAssignment rows — customers whose treatment actually diverged —
 * and outcomes from each assignment's first-exposure contract. The numbers
 * here are the quick per-arm scoreboard; the honest final judgment is cohort
 * LTGP on the Analytics tab (OFFER_PLAYBOOK §7), and the grade chip says
 * plainly when the sample is too small to mean anything — a single store
 * detects big effects only, and big effects are the only ones worth acting
 * on.
 */

// Below this many exposures per arm the numbers are noise, full stop.
const MIN_EXPOSURES_DIRECTION = 30;
// Between the two thresholds: direction only, don't ship decisions on it.
const MIN_EXPOSURES_USABLE = 200;

interface ArmStats {
  arm: string;
  description: string;
  share: number;
  exposed: number;
  contractsLinked: number;
  stillSubscribed: number;
  cancelled: number;
  reachedOrder3: number;
  avgLifetimeRevenueCents: number;
}

interface ExperimentView {
  key: string;
  name: string;
  hypothesis: string;
  primaryMetric: string;
  enabled: boolean;
  startedAt: string | null;
  stoppedAt: string | null;
  defaultEnabled: boolean;
  grade: "too_early" | "direction_only" | "usable";
  arms: ArmStats[];
}

interface ActionData {
  intent: string;
  ok: boolean;
  toast?: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }

  const settings = await getSetting(shop.id, "experiments");
  const views: ExperimentView[] = [];

  for (const def of EXPERIMENTS) {
    const entry = settings.entries[def.key];
    const enabled = entry ? entry.enabled && !entry.stoppedAt : def.defaultEnabled;

    const assignments = await prisma.experimentAssignment.findMany({
      where: { shopId: shop.id, experimentKey: def.key },
      select: { arm: true, contractId: true },
      // The readout is a scoreboard, not an export — a hard cap keeps the
      // page fast; the analytics engines own exhaustive analysis.
      take: 10_000,
    });

    const contractIds = assignments
      .map((a) => a.contractId)
      .filter((id): id is string => id != null);
    const contracts =
      contractIds.length > 0
        ? await prisma.subscriptionContract.findMany({
            where: { id: { in: contractIds } },
            select: {
              id: true,
              status: true,
              ordersCount: true,
              lifetimeRevenueCents: true,
            },
          })
        : [];
    const byId = new Map(contracts.map((c) => [c.id, c]));

    const arms: ArmStats[] = def.arms.map((arm) => {
      const rows = assignments.filter((a) => a.arm === arm.key);
      const linked = rows
        .map((a) => (a.contractId ? byId.get(a.contractId) : undefined))
        .filter((c): c is NonNullable<typeof c> => c != null);
      const revenueSum = linked.reduce(
        (sum, c) => sum + c.lifetimeRevenueCents,
        0,
      );
      return {
        arm: arm.key,
        description: arm.description,
        share: arm.share,
        exposed: rows.length,
        contractsLinked: linked.length,
        stillSubscribed: linked.filter(
          (c) => c.status === "ACTIVE" || c.status === "PAUSED",
        ).length,
        cancelled: linked.filter((c) => c.status === "CANCELLED").length,
        reachedOrder3: linked.filter((c) => c.ordersCount >= 3).length,
        avgLifetimeRevenueCents:
          linked.length > 0 ? Math.round(revenueSum / linked.length) : 0,
      };
    });

    const smallestArm = Math.min(...arms.map((a) => a.exposed));
    const grade: ExperimentView["grade"] =
      smallestArm < MIN_EXPOSURES_DIRECTION
        ? "too_early"
        : smallestArm < MIN_EXPOSURES_USABLE
          ? "direction_only"
          : "usable";

    views.push({
      key: def.key,
      name: def.name,
      hypothesis: def.hypothesis,
      primaryMetric: def.primaryMetric,
      enabled,
      startedAt: entry?.startedAt ?? null,
      stoppedAt: entry?.stoppedAt ?? null,
      defaultEnabled: def.defaultEnabled,
      grade,
      arms,
    });
  }

  return json({ currencyCode: shop.currencyCode, experiments: views });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }
  const actor =
    session.onlineAccessInfo?.associated_user?.email ?? `admin@${session.shop}`;
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "toggle-experiment") {
    const key = String(formData.get("key") ?? "");
    const enable = formData.get("enabled") === "true";
    const def = experimentByKey(key);
    if (!def) {
      return json<ActionData>(
        { intent, ok: false, toast: "Unknown experiment" },
        { status: 404 },
      );
    }
    const settings = await getSetting(shop.id, "experiments");
    const prior = settings.entries[key];
    const now = new Date().toISOString();
    const next = {
      ...settings,
      entries: {
        ...settings.entries,
        [key]: {
          enabled: enable,
          // startedAt is the first-ever enable; stopping stamps stoppedAt so
          // readouts can window their outcome queries. Re-enabling clears it
          // (assignments stay frozen either way).
          startedAt: prior?.startedAt ?? (enable ? now : null),
          stoppedAt: enable ? null : now,
        },
      },
    };
    await setSetting(shop.id, "experiments", next, actor);
    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "ADMIN",
      actor,
      payload: {
        action: enable ? "experiment_enabled" : "experiment_stopped",
        experimentKey: key,
        previousEnabled: prior?.enabled ?? def.defaultEnabled,
      },
    });
    return json<ActionData>({
      intent,
      ok: true,
      toast: enable ? "Experiment enabled" : "Experiment stopped",
    });
  }

  return json<ActionData>(
    { intent, ok: false, toast: "Unknown action" },
    { status: 400 },
  );
};

function gradeBadge(grade: ExperimentView["grade"]): JSX.Element {
  switch (grade) {
    case "usable":
      return <Badge tone="success">Enough data to read</Badge>;
    case "direction_only":
      return <Badge tone="attention">Direction only — keep running</Badge>;
    default:
      return <Badge tone="warning">Too early — numbers are noise</Badge>;
  }
}

export default function ExperimentsPage() {
  const { currencyCode, experiments } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  useEffect(() => {
    if (actionData?.toast) {
      shopify.toast.show(actionData.toast, { isError: !actionData.ok });
    }
  }, [actionData, shopify]);

  return (
    <Page
      title="Experiments"
      subtitle="Deterministic customer-level test groups — the same customer always lands in the same arm, and an arm is frozen the moment treatment diverges."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner tone="info" title="How to read this page">
              <Text as="p" variant="bodySm">
                Populations count only customers whose treatment actually
                diverged. The quick numbers here are leading indicators — the
                final judgment for any experiment is cohort LTGP at months
                3/6/12 on the Analytics tab. One store detects big effects
                only; if an arm difference doesn't survive the grade chip's
                caution, it isn't a result yet.
              </Text>
            </Banner>

            {experiments.map((exp) => (
              <Card key={exp.key}>
                <BlockStack gap="300">
                  <InlineStack gap="300" blockAlign="center" wrap>
                    <Text as="h2" variant="headingMd">
                      {exp.name}
                    </Text>
                    {exp.enabled ? (
                      <Badge tone="success">Running</Badge>
                    ) : (
                      <Badge>Stopped</Badge>
                    )}
                    {gradeBadge(exp.grade)}
                    <InlineStack align="end">
                      <Button
                        size="slim"
                        loading={busy}
                        tone={exp.enabled ? "critical" : undefined}
                        onClick={() =>
                          submit(
                            {
                              intent: "toggle-experiment",
                              key: exp.key,
                              enabled: String(!exp.enabled),
                            },
                            { method: "post" },
                          )
                        }
                      >
                        {exp.enabled ? "Stop" : "Enable"}
                      </Button>
                    </InlineStack>
                  </InlineStack>
                  <Text as="p" tone="subdued" variant="bodySm">
                    {exp.hypothesis}
                  </Text>
                  <Text as="p" variant="bodySm">
                    <Text as="span" fontWeight="medium">
                      Judge on:
                    </Text>{" "}
                    {exp.primaryMetric}
                  </Text>
                  <Divider />
                  <DataTable
                    columnContentTypes={[
                      "text",
                      "numeric",
                      "numeric",
                      "numeric",
                      "numeric",
                      "numeric",
                      "numeric",
                    ]}
                    headings={[
                      "Arm",
                      "Share",
                      "Customers",
                      "Still subscribed",
                      "Cancelled",
                      "Reached order 3",
                      "Avg renewal revenue",
                    ]}
                    rows={exp.arms.map((arm) => [
                      `${arm.arm} — ${arm.description}`,
                      `${arm.share}%`,
                      arm.exposed,
                      arm.contractsLinked > 0
                        ? `${arm.stillSubscribed} (${Math.round((arm.stillSubscribed / arm.contractsLinked) * 100)}%)`
                        : "—",
                      arm.contractsLinked > 0 ? arm.cancelled : "—",
                      arm.contractsLinked > 0 ? arm.reachedOrder3 : "—",
                      arm.contractsLinked > 0
                        ? formatMoney(arm.avgLifetimeRevenueCents, currencyCode)
                        : "—",
                    ])}
                  />
                  {exp.startedAt ? (
                    <Text as="p" tone="subdued" variant="bodySm">
                      Started {exp.startedAt.slice(0, 10)}
                      {exp.stoppedAt
                        ? ` · stopped ${exp.stoppedAt.slice(0, 10)}`
                        : ""}
                    </Text>
                  ) : exp.defaultEnabled && exp.enabled ? (
                    <Text as="p" tone="subdued" variant="bodySm">
                      On by default since install — this one must exist from
                      subscriber #1 or its comparison group can never be
                      created.
                    </Text>
                  ) : null}
                </BlockStack>
              </Card>
            ))}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
