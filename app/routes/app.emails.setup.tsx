import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, SerializeFrom } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import type { ShouldRevalidateFunction } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Collapsible,
  Divider,
  InlineStack,
  IndexTable,
  Layout,
  Link as PolarisLink,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { getSetting, setSetting } from "~/lib/settings/settings.server";
import { logEvent } from "~/lib/events/log.server";
import { encryptSecret } from "~/lib/crypto/secrets.server";
import {
  isKlaviyoConfigured,
  probeKlaviyoKey,
  resolveKlaviyoAuth,
} from "~/lib/klaviyo/client.server";
import {
  EXCLUDED_FROM_SETUP,
  runGuidedSetup,
  verifyFlowCoverage,
  type CoverageRow,
  type SetupReport,
} from "~/lib/klaviyo/flows.server";
import { EMAIL_CATALOG } from "~/lib/notifications/catalog.server";

/**
 * Guided Klaviyo delivery setup (v1.18.0) — three steps, zero jargon:
 *
 *  1. Connect a Klaviyo key that is allowed to manage flows (click-by-click
 *     instructions; paste box right here — no detour through Settings).
 *  2. One button creates every flow in Klaviyo: metric trigger, the
 *     cellexia_send safety filter, and an email that renders exactly what
 *     the app wrote. Idempotent — click it until everything is green.
 *  3. A live checklist: every subscription email with a green check when a
 *     LIVE flow delivers it (the merchant's own hand-built flows count).
 *
 * The loader verifies against Klaviyo on every visit and refreshes the
 * cached coverage the Emails overview card + daily alert check read.
 */

function actorFromSession(session: {
  onlineAccessInfo?: { associated_user?: { email?: string | null } | null } | null;
  shop: string;
}): string {
  return (
    session.onlineAccessInfo?.associated_user?.email ?? `admin@${session.shop}`
  );
}

/** Deterministic (fixed locale + UTC) — a bare toLocaleString() would
 * hydration-mismatch between server and browser locales. */
function formatUtcLabel(iso: string): string {
  return `${new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(iso))} UTC`;
}

/**
 * run-setup/refresh actions already return AND persist a fresh report —
 * re-running the loader (a full live Klaviyo verification) straight after
 * would double the API traffic for nothing. save-key keeps the default so
 * data.configured/keySource refresh.
 */
export const shouldRevalidate: ShouldRevalidateFunction = ({
  formData,
  defaultShouldRevalidate,
}) => {
  const intent = formData?.get("intent");
  if (intent === "run-setup" || intent === "refresh") return false;
  return defaultShouldRevalidate;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }
  const [configured, auth] = await Promise.all([
    isKlaviyoConfigured(shop.id).catch(() => false),
    resolveKlaviyoAuth(shop.id).catch(() => ({ apiKey: null, source: null })),
  ]);
  let report: SetupReport | null = null;
  if (configured) {
    try {
      report = await verifyFlowCoverage(shop.id);
    } catch (err) {
      console.error("[emails-setup] verification failed", err);
    }
  }
  return json({
    configured,
    keySource: auth.source,
    report,
    excluded: EXCLUDED_FROM_SETUP.map((e) => ({
      title: EMAIL_CATALOG[e.template].title,
      reason: e.reason,
    })),
    actorEmail: actorFromSession(session),
  });
};

interface ActionData {
  intent: string;
  ok: boolean;
  toast?: string;
  report?: SetupReport;
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

  if (intent === "save-key") {
    const key = String(formData.get("key") ?? "").trim();
    if (!key.startsWith("pk_")) {
      return json<ActionData>(
        {
          intent,
          ok: false,
          toast: "That does not look like a private key — it starts with pk_",
        },
        { status: 422 },
      );
    }
    // Validate BEFORE saving — a wrong saved key would dead-letter queued
    // events within a minute (same rule as the Settings page test button).
    const probe = await probeKlaviyoKey(key);
    if (!probe.ok) {
      return json<ActionData>({ intent, ok: false, toast: probe.detail }, { status: 422 });
    }
    const previous = await getSetting(shop.id, "klaviyo");
    await setSetting(
      shop.id,
      "klaviyo",
      { ...previous, privateApiKey: encryptSecret(key) },
      actor,
    );
    // Audit with redaction markers — never key material (Settings-page rule).
    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "ADMIN",
      actor,
      payload: {
        action: "settings_updated",
        key: "klaviyo",
        value: { privateApiKey: "(updated)" },
        previous: {
          privateApiKey: previous.privateApiKey ? "(set)" : "(not set)",
        },
      },
    });
    return json<ActionData>({
      intent,
      ok: true,
      toast: "Klaviyo key saved — it applies within a minute",
    });
  }

  if (intent === "run-setup") {
    // Seed events create a Klaviyo profile for their recipient — resolve a
    // REAL merchant address the way admin mail does (alerts recipients,
    // then the shop contact), falling back to the session user. The bare
    // actor fallback can be a fabricated admin@shop.myshopify.com.
    const alerts = await getSetting(shop.id, "alerts");
    const seedEmail =
      alerts.emailTo.find((e: string) => e.includes("@")) ??
      shop.contactEmail ??
      actor;
    const report = await runGuidedSetup(shop.id, seedEmail);
    const live = report.rows.filter((r) => r.status === "live").length;
    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "ADMIN",
      actor,
      payload: {
        action: "klaviyo_flow_setup",
        live,
        total: report.rows.length,
        seeded: report.seeded.length,
        fatal: report.fatal ?? null,
      },
    });
    return json<ActionData>({
      intent,
      ok: report.ok,
      report,
      toast: report.fatal
        ? report.fatal
        : `${live} of ${report.rows.length} emails are now delivered by a live Klaviyo flow`,
    });
  }

  if (intent === "refresh") {
    const report = await verifyFlowCoverage(shop.id);
    return json<ActionData>({ intent, ok: report.ok, report });
  }

  return json<ActionData>({ intent, ok: false, toast: "Unknown action" }, { status: 400 });
};

// ── UI ───────────────────────────────────────────────────────────────────────

type LoaderData = SerializeFrom<typeof loader>;
type SerializedRow = SerializeFrom<CoverageRow>;

const STATUS_META: Record<
  string,
  { label: string; tone?: "success" | "warning" | "critical" | "attention" }
> = {
  live: { label: "Live", tone: "success" },
  not_live: { label: "Needs one click", tone: "warning" },
  missing: { label: "Not set up", tone: "critical" },
  pending_metric: { label: "Waiting for Klaviyo", tone: "attention" },
  rate_limited: { label: "Click again in a minute", tone: "attention" },
  app_delivers: { label: "Cellexia delivers it", tone: "success" },
  off: { label: "Turned off in the app" },
  error: { label: "Problem", tone: "critical" },
};

/** Rows that count toward the "X of Y live" flow tally. */
const NEEDS_FLOW = (status: string): boolean =>
  status !== "app_delivers" && status !== "off";

export default function KlaviyoSetupPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const navigation = useNavigation();

  const [key, setKey] = useState("");
  const [showKeyHelp, setShowKeyHelp] = useState(!data.configured);

  const navIntent = navigation.formData?.get("intent");
  const savingKey = navigation.state === "submitting" && navIntent === "save-key";
  const running = navigation.state === "submitting" && navIntent === "run-setup";
  const refreshing = navigation.state === "submitting" && navIntent === "refresh";

  useEffect(() => {
    if (actionData?.toast) {
      shopify.toast.show(actionData.toast, { isError: !actionData.ok });
    }
    if (actionData?.intent === "save-key" && actionData.ok) setKey("");
  }, [actionData, shopify]);

  const report = actionData?.report ?? data.report;
  const rows = (report?.rows ?? []) as SerializedRow[];
  const flowRows = rows.filter((r) => NEEDS_FLOW(r.status));
  const liveCount = flowRows.filter((r) => r.status === "live").length;
  const allLive = flowRows.length > 0 && liveCount === flowRows.length;
  const pendingCount = flowRows.filter(
    (r) => r.status === "pending_metric" || r.status === "rate_limited",
  ).length;

  const post = (intent: string): void => {
    const form = new FormData();
    form.set("intent", intent);
    submit(form, { method: "post" });
  };

  return (
    <Page
      title="Klaviyo delivery setup"
      subtitle="Let Klaviyo deliver every subscription email — best-in-class deliverability, while the app keeps writing every word. Three steps, no technical knowledge needed."
      backAction={{ content: "Emails", url: "/app/emails" }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {allLive && (
              <Banner tone="success" title="You're done — Klaviyo delivers everything">
                <p>
                  All {flowRows.length} Klaviyo-delivered subscription emails
                  have a live flow. Copy, design and timing stay controlled
                  from the Emails pages — you never need to edit these flows.
                </p>
              </Banner>
            )}
            {report?.fatal && (
              <Banner tone="warning" title="One thing to fix first">
                <p>{report.fatal}</p>
              </Banner>
            )}

            {/* ── Step 1 ─────────────────────────────────────────────── */}
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Step 1 — Connect a Klaviyo key that can manage flows
                  </Text>
                  {data.configured ? (
                    <Badge tone="success">
                      {`Key connected (${data.keySource === "settings" ? "saved in app" : "server setting"})`}
                    </Badge>
                  ) : (
                    <Badge tone="critical">No key yet</Badge>
                  )}
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  The key is like a staff badge the app shows Klaviyo. Your
                  current one may only be allowed to report events — creating
                  flows for you needs a badge with a few more permissions.
                  Making one takes about a minute:
                </Text>
                <Button
                  variant="plain"
                  size="slim"
                  disclosure={showKeyHelp ? "up" : "down"}
                  onClick={() => setShowKeyHelp((v) => !v)}
                >
                  Show me how to create the key
                </Button>
                <Collapsible id="key-help" open={showKeyHelp}>
                  <Box background="bg-surface-secondary" borderRadius="200" padding="300">
                    <BlockStack gap="150">
                      <Text as="p" variant="bodySm">
                        1. Open{" "}
                        <PolarisLink
                          url="https://www.klaviyo.com/settings/account/api-keys"
                          target="_blank"
                        >
                          Klaviyo → Settings → API keys
                        </PolarisLink>{" "}
                        (log in as the account owner).
                      </Text>
                      <Text as="p" variant="bodySm">
                        2. Click <b>Create Private API Key</b> and name it
                        &ldquo;Cellexia Subscriptions&rdquo;.
                      </Text>
                      <Text as="p" variant="bodySm">
                        3. Choose <b>Custom</b> access and tick exactly these
                        four: <b>Events — Full</b>, <b>Metrics — Read</b>,{" "}
                        <b>Flows — Full</b>, <b>Templates — Full</b>.
                      </Text>
                      <Text as="p" variant="bodySm">
                        4. Click Create, copy the key (it starts with{" "}
                        <code>pk_</code> and is shown only once), and paste it
                        below.
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Replacing the key here is safe — everything already
                        connected keeps working, and the key is stored
                        encrypted.
                      </Text>
                    </BlockStack>
                  </Box>
                </Collapsible>
                <InlineStack gap="200" blockAlign="end" wrap={false}>
                  <Box width="100%">
                    <TextField
                      autoComplete="off"
                      label="Private API key"
                      value={key}
                      onChange={setKey}
                      placeholder="pk_…"
                      type="password"
                    />
                  </Box>
                  <Button
                    onClick={() => {
                      const form = new FormData();
                      form.set("intent", "save-key");
                      form.set("key", key);
                      submit(form, { method: "post" });
                    }}
                    loading={savingKey}
                    disabled={key.trim() === ""}
                  >
                    Test &amp; save
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* ── Step 2 ─────────────────────────────────────────────── */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Step 2 — Create your flows
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  One click builds every missing flow in your Klaviyo account:
                  each one listens for its subscription moment and delivers
                  the exact email you see in the app&rsquo;s previews. Emails
                  you already handle with your own live flows are left
                  untouched — nothing is ever duplicated. Safe to click as
                  many times as it takes.
                </Text>
                <InlineStack gap="200">
                  <Button
                    variant="primary"
                    onClick={() => post("run-setup")}
                    loading={running}
                    disabled={!data.configured}
                  >
                    Create my flows
                  </Button>
                  {!data.configured && (
                    <Text as="span" variant="bodySm" tone="subdued">
                      Connect a key in step 1 first.
                    </Text>
                  )}
                </InlineStack>
                {(report?.seeded?.length ?? 0) > 0 && (
                  <Banner tone="info">
                    <p>
                      {report?.seeded.length} of your subscription moments were
                      brand new to Klaviyo, so the app just introduced them
                      (no emails were sent doing this). Klaviyo needs a moment
                      to register them — if some rows below say &ldquo;Waiting
                      for Klaviyo&rdquo;, click <b>Create my flows</b> again in
                      about a minute.
                    </p>
                  </Banner>
                )}
              </BlockStack>
            </Card>

            {/* ── Step 3 ─────────────────────────────────────────────── */}
            <Card padding="0">
              <Box padding="400" paddingBlockEnd="200">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="050">
                    <Text as="h2" variant="headingMd">
                      Step 3 — Your delivery checklist
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {rows.length > 0
                        ? `${liveCount} of ${flowRows.length} live${
                            pendingCount > 0 ? ` · ${pendingCount} waiting` : ""
                          } · checked ${
                            report?.checkedAt
                              ? formatUtcLabel(report.checkedAt)
                              : "—"
                          }`
                        : "Connect a key to see the checklist."}
                    </Text>
                  </BlockStack>
                  <Button size="slim" onClick={() => post("refresh")} loading={refreshing}>
                    Check again
                  </Button>
                </InlineStack>
              </Box>
              <IndexTable
                resourceName={{ singular: "email", plural: "emails" }}
                itemCount={rows.length}
                selectable={false}
                headings={[
                  { title: "Email" },
                  { title: "Status" },
                  { title: "Delivered by" },
                ]}
              >
                {rows.map((row, index) => {
                  const meta = STATUS_META[row.status] ?? { label: row.status };
                  return (
                    <IndexTable.Row id={row.key} key={row.key} position={index}>
                      <IndexTable.Cell>
                        <BlockStack gap="050">
                          <Text as="span" fontWeight="semibold">
                            {row.name.replace(/^Cellexia — /, "")}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {row.why}
                          </Text>
                          {row.detail && (
                            <Text as="span" variant="bodySm" tone="subdued">
                              {row.detail}
                            </Text>
                          )}
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {row.flowName ? (
                          <Text as="span" variant="bodySm">
                            {row.flowName}
                            {row.ours ? "" : " (your own flow)"}
                          </Text>
                        ) : (
                          <Text as="span" variant="bodySm" tone="subdued">
                            —
                          </Text>
                        )}
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );
                })}
              </IndexTable>
              <Box padding="400">
                <BlockStack gap="200">
                  <Divider />
                  <Text as="h3" variant="headingSm">
                    Not part of this setup — on purpose
                  </Text>
                  {data.excluded.map((e) => (
                    <Text key={e.title} as="p" variant="bodySm" tone="subdued">
                      <b>{e.title}:</b> {e.reason}
                    </Text>
                  ))}
                  <Text as="p" variant="bodySm" tone="subdued">
                    The app checks this list daily and raises an alert if a
                    flow is ever deleted or paused, so a missing email can
                    never go unnoticed.
                  </Text>
                </BlockStack>
              </Box>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
