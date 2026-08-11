import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, SerializeFrom } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
  useSubmit,
} from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Banner,
  Button,
  Card,
  Checkbox,
  InlineStack,
  IndexTable,
  Layout,
  Link as PolarisLink,
  Modal,
  Page,
  Tabs,
  Text,
  TextField,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";

import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { getSetting, setSetting } from "~/lib/settings/settings.server";
import { settingsSchemas, type SettingsKey } from "~/lib/settings/registry.server";
import { logEvent } from "~/lib/events/log.server";
import { isKlaviyoConfigured } from "~/lib/klaviyo/client.server";
import { eventMetricEntries } from "~/lib/klaviyo/events-map.server";
import { TEMPLATES, isTemplateKey } from "~/lib/notifications/templates.server";
import {
  EMAIL_CATALOG,
  emailCatalogEntries,
  type CatalogTiming,
} from "~/lib/notifications/catalog.server";

/**
 * Emails tab (v1.16.0) — every message the app sends, in one place:
 *
 * - the catalog (what, when, why), with per-template enable/disable;
 * - in-app content customization (subject/body) delivered THROUGH Klaviyo —
 *   the router renders the copy into `content_subject` / `content_html` /
 *   `content_text` event properties, so a flow email built as
 *   `{{ event.content_html }}` always carries what is written here (and the
 *   direct-SMTP fallback renders the identical copy);
 * - send-timing knobs (reminder lead times, dunning ladder, win-back
 *   offsets) — the SAME settings the Settings page owns, edited through the
 *   same audited pipeline;
 * - the one-click actions each email can carry ({skip_url}, {delay_1w_url},
 *   {delay_3w_url}, {addon_url}, …) — proven churn reducers vs a bare
 *   "manage subscription" link;
 * - the sent log (NotificationLog) for observability.
 */

const LOG_PAGE_SIZE = 100;

/** Variables available to every customized body, shown in the editor help. */
const COMMON_PLACEHOLDERS = [
  "{portal_url}",
  "{first_name}",
  "{total_estimate}",
  "{next_date}",
  "{items_summary}",
  "{frequency}",
  "{cta}",
] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }

  const url = new URL(request.url);
  const logTemplateParam = url.searchParams.get("logTemplate") ?? "";
  const logTemplate = isTemplateKey(logTemplateParam) ? logTemplateParam : null;

  const [
    emails,
    notifications,
    dunning,
    pause,
    winback,
    lifecycle,
    priceChangePolicy,
    klaviyoConfigured,
    sentCounts,
    logRows,
  ] = await Promise.all([
    getSetting(shop.id, "emails"),
    getSetting(shop.id, "notifications"),
    getSetting(shop.id, "dunning"),
    getSetting(shop.id, "pause"),
    getSetting(shop.id, "winback"),
    getSetting(shop.id, "lifecycle"),
    getSetting(shop.id, "priceChangePolicy"),
    isKlaviyoConfigured(shop.id).catch(() => false),
    prisma.notificationLog.groupBy({
      by: ["template", "status"],
      where: { shopId: shop.id },
      _count: { _all: true },
    }),
    prisma.notificationLog.findMany({
      where: { shopId: shop.id, ...(logTemplate ? { template: logTemplate } : {}) },
      orderBy: { createdAt: "desc" },
      take: LOG_PAGE_SIZE,
      select: {
        id: true,
        createdAt: true,
        template: true,
        channel: true,
        status: true,
        email: true,
        phone: true,
        error: true,
        contractId: true,
      },
    }),
  ]);

  // Current timing values resolve off the loaded groups; all catalog timing
  // paths are flat keys of their group (see catalog.server.ts).
  const groups: Record<string, Record<string, unknown>> = {
    notifications: notifications as unknown as Record<string, unknown>,
    dunning: dunning as unknown as Record<string, unknown>,
    pause: pause as unknown as Record<string, unknown>,
    winback: winback as unknown as Record<string, unknown>,
    lifecycle: lifecycle as unknown as Record<string, unknown>,
    priceChangePolicy: priceChangePolicy as unknown as Record<string, unknown>,
  };
  const timingValue = (timing: CatalogTiming | null): string => {
    if (!timing) return "";
    const value = groups[timing.settingsKey]?.[timing.path];
    if (Array.isArray(value)) return value.join(", ");
    return value == null ? "" : String(value);
  };

  const sentCount = new Map<string, number>();
  for (const row of sentCounts) {
    if (row.status === "SENT") {
      sentCount.set(
        row.template,
        (sentCount.get(row.template) ?? 0) + row._count._all,
      );
    }
  }

  const entries = emailCatalogEntries().map((entry) => {
    const override = emails.templates[entry.template];
    return {
      ...entry,
      metric: TEMPLATES[entry.template].klaviyoMetric,
      channel: TEMPLATES[entry.template].channel,
      critical: TEMPLATES[entry.template].critical,
      enabled: override?.enabled !== false,
      subject: override?.subject ?? "",
      body: override?.body ?? "",
      timingValue: timingValue(entry.timing),
      sentCount: sentCount.get(entry.template) ?? 0,
    };
  });

  return json({
    entries,
    flows: eventMetricEntries(),
    klaviyoConfigured,
    logRows,
    logTemplate,
  });
};

type LoaderData = SerializeFrom<typeof loader>;
type EmailEntry = LoaderData["entries"][number];

interface ActionData {
  intent: string;
  ok: boolean;
  /** Template the submission was for — scopes validation errors to it. */
  template?: string;
  toast?: string;
  errors?: Record<string, string>;
}

function actorFromSession(session: {
  onlineAccessInfo?: { associated_user?: { email?: string | null } | null } | null;
  shop: string;
}): string {
  return (
    session.onlineAccessInfo?.associated_user?.email ?? `admin@${session.shop}`
  );
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

  if (intent !== "save-template") {
    return json<ActionData>({ intent, ok: false, toast: "Unknown action" }, { status: 400 });
  }

  const template = String(formData.get("template") ?? "");
  if (!isTemplateKey(template)) {
    return json<ActionData>(
      { intent, ok: false, toast: "Unknown email template" },
      { status: 400 },
    );
  }
  const catalog = EMAIL_CATALOG[template];
  if (catalog.flowOwned) {
    return json<ActionData>(
      {
        intent,
        ok: false,
        template,
        toast: "This message is owned by your Klaviyo flow",
      },
      { status: 400 },
    );
  }

  const errors: Record<string, string> = {};

  // ── 1. Content + enabled → the `emails` setting ─────────────────────────
  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const enabledRaw = String(formData.get("enabled") ?? "true");
  const enabled = catalog.disableable ? enabledRaw === "true" : true;
  if (!catalog.customizable && (subject !== "" || body !== "")) {
    errors.subject = "This system email keeps its built-in content";
  }
  if (subject.length > 300) errors.subject = "Keep the subject under 300 characters";
  if (body.length > 10_000) errors.body = "Keep the body under 10 000 characters";

  // ── 2. Timing → the owning settings group, schema-validated ─────────────
  const timing = catalog.timing;
  const timingRaw = String(formData.get("timing") ?? "").trim();
  let timingChange: {
    key: SettingsKey;
    value: Record<string, unknown>;
    previous: unknown;
  } | null = null;
  if (timing && timingRaw !== "") {
    const previousGroup = await getSetting(shop.id, timing.settingsKey);
    const candidate = JSON.parse(JSON.stringify(previousGroup)) as Record<
      string,
      unknown
    >;
    if (timing.kind === "intList") {
      const parts = timingRaw.split(/[,\s]+/).filter(Boolean);
      const values = parts.map((p) => Number(p));
      if (values.some((v) => !Number.isInteger(v))) {
        errors.timing = "Use whole numbers separated by commas";
      } else {
        candidate[timing.path] = values;
      }
    } else {
      const value = Number(timingRaw);
      if (!Number.isInteger(value)) {
        errors.timing = "Use a whole number";
      } else {
        candidate[timing.path] = value;
      }
    }
    if (!errors.timing) {
      const parsed = settingsSchemas[timing.settingsKey].safeParse(candidate);
      if (!parsed.success) {
        errors.timing =
          parsed.error.issues[0]?.message ?? "Invalid timing value";
      } else {
        timingChange = {
          key: timing.settingsKey,
          value: parsed.data as Record<string, unknown>,
          previous: previousGroup,
        };
      }
    }
  }

  if (Object.keys(errors).length > 0) {
    return json<ActionData>(
      { intent, ok: false, template, errors },
      { status: 422 },
    );
  }

  // Persist the emails setting (read previous BEFORE the write — the
  // settings_updated audit contract carries both sides). No-op saves are
  // skipped entirely: the audit log is append-only and one settings_updated
  // event should mean one real change, not every modal round-trip.
  const previousEmails = await getSetting(shop.id, "emails");
  const nextTemplates = { ...previousEmails.templates };
  if (enabled && subject === "" && body === "") {
    // Fully default again — drop the row instead of storing an empty husk.
    delete nextTemplates[template];
  } else {
    nextTemplates[template] = { enabled, subject, body };
  }
  const nextEmails = { templates: nextTemplates };
  if (JSON.stringify(nextEmails) !== JSON.stringify(previousEmails)) {
    await setSetting(shop.id, "emails", nextEmails, actor);
    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "ADMIN",
      actor,
      payload: {
        action: "settings_updated",
        key: "emails",
        value: nextEmails,
        previous: previousEmails,
      },
    });
  }

  if (
    timingChange &&
    JSON.stringify(timingChange.value) !== JSON.stringify(timingChange.previous)
  ) {
    await setSetting(
      shop.id,
      timingChange.key,
      timingChange.value as never,
      actor,
    );
    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "ADMIN",
      actor,
      payload: {
        action: "settings_updated",
        key: timingChange.key,
        value: timingChange.value,
        previous: timingChange.previous,
      },
    });
  }

  return json<ActionData>({
    intent,
    ok: true,
    template,
    toast: `${catalog.title} saved`,
  });
};

// ── UI ───────────────────────────────────────────────────────────────────────

const GROUP_LABELS: Record<EmailEntry["group"], string> = {
  reminders: "Reminders",
  orders: "Orders & changes",
  payments: "Payments & recovery",
  lifecycle: "Lifecycle & gifts",
  winback: "Win-back",
  system: "System",
};

const STATUS_TONE: Record<string, "success" | "critical" | "warning" | undefined> =
  {
    SENT: "success",
    FAILED: "critical",
    SUPPRESSED: "warning",
  };

export default function EmailsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam = searchParams.get("tab") === "activity" ? 1 : 0;
  const [editing, setEditing] = useState<EmailEntry | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [timing, setTiming] = useState("");

  const saving = navigation.state === "submitting";

  useEffect(() => {
    if (actionData?.toast) {
      shopify.toast.show(actionData.toast, { isError: !actionData.ok });
    }
    if (actionData?.ok) setEditing(null);
  }, [actionData, shopify]);

  const openEditor = useCallback((entry: EmailEntry) => {
    setEditing(entry);
    setSubject(entry.subject);
    setBody(entry.body);
    setEnabled(entry.enabled);
    setTiming(entry.timingValue);
  }, []);

  // Validation errors belong to ONE submission — surfacing them on a
  // different template's modal would show stale red fields.
  const editorErrors =
    editing && actionData?.template === editing.template
      ? actionData?.errors
      : undefined;

  const saveEditing = useCallback(() => {
    if (!editing) return;
    const form = new FormData();
    form.set("intent", "save-template");
    form.set("template", editing.template);
    form.set("subject", subject);
    form.set("body", body);
    form.set("enabled", String(enabled));
    form.set("timing", timing);
    submit(form, { method: "post" });
  }, [editing, subject, body, enabled, timing, submit]);

  const grouped = useMemo(() => {
    const byGroup = new Map<EmailEntry["group"], EmailEntry[]>();
    for (const entry of data.entries) {
      const list = byGroup.get(entry.group) ?? [];
      list.push(entry);
      byGroup.set(entry.group, list);
    }
    return byGroup;
  }, [data.entries]);

  const tabs = [
    { id: "catalog", content: "Emails" },
    { id: "activity", content: "Sent log" },
  ];

  return (
    <Page
      title="Emails"
      subtitle="Every message this app sends — content, timing and one-click actions, delivered through your Klaviyo flows."
    >
      <Layout>
        <Layout.Section>
          {!data.klaviyoConfigured && (
            <Banner tone="warning" title="Klaviyo is not connected">
              <p>
                Without a Klaviyo API key (Settings → Klaviyo), emails fall
                back to plain direct email and SMS is suppressed. Connect
                Klaviyo so your flows own branding and consent.
              </p>
            </Banner>
          )}
          <Box paddingBlockStart={data.klaviyoConfigured ? "0" : "400"}>
            <Tabs
              tabs={tabs}
              selected={tabParam}
              onSelect={(index) => {
                setSearchParams(
                  (prev) => {
                    const next = new URLSearchParams(prev);
                    if (index === 1) next.set("tab", "activity");
                    else next.delete("tab");
                    return next;
                  },
                  { replace: true, preventScrollReset: true },
                );
              }}
            >
              <Box paddingBlockStart="400">
                {tabParam === 0 ? (
                  <BlockStack gap="400">
                    <Card>
                      <BlockStack gap="200">
                        <Text as="h3" variant="headingMd">
                          How customization reaches your customers
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          Each email send carries your customized subject and
                          body as the Klaviyo event properties{" "}
                          <code>content_subject</code>, <code>content_html</code>{" "}
                          and <code>content_text</code> — build a flow email
                          whose body is{" "}
                          <code>{"{{ event.content_html }}"}</code> and it
                          always matches what you write here (the SMS event
                          carries <code>content_text</code> only; rows marked
                          &ldquo;Klaviyo flow&rdquo; keep their content in the
                          flow itself). One-click action links ({"{skip_url}"},{" "}
                          {"{delay_1w_url}"}, {"{delay_3w_url}"},{" "}
                          {"{addon_url}"}, {"{pause_url}"}) are substituted
                          into your copy and also travel as their own event
                          properties. See docs/KLAVIYO_SETUP.md.
                        </Text>
                      </BlockStack>
                    </Card>
                    {[...grouped.entries()].map(([group, entries]) => (
                      <Card key={group} padding="0">
                        <Box padding="400" paddingBlockEnd="200">
                          <Text as="h3" variant="headingMd">
                            {GROUP_LABELS[group]}
                          </Text>
                        </Box>
                        <IndexTable
                          resourceName={{ singular: "email", plural: "emails" }}
                          itemCount={entries.length}
                          selectable={false}
                          headings={[
                            { title: "Email" },
                            { title: "Trigger & timing" },
                            { title: "Status" },
                            { title: "Sent" },
                            { title: "" },
                          ]}
                        >
                          {entries.map((entry, index) => (
                            <IndexTable.Row
                              id={entry.template}
                              key={entry.template}
                              position={index}
                            >
                              <IndexTable.Cell>
                                <BlockStack gap="050">
                                  <Text as="span" fontWeight="semibold">
                                    {entry.title}
                                  </Text>
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    {entry.channel === "SMS" ? "SMS" : "Email"}
                                    {entry.metric ? ` · ${entry.metric}` : " · direct only"}
                                  </Text>
                                </BlockStack>
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                <BlockStack gap="050">
                                  <Text as="span" variant="bodySm">
                                    {entry.trigger}
                                  </Text>
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    {entry.sentBy}
                                    {entry.timing
                                      ? ` · ${entry.timing.label.toLowerCase()} ${entry.timingValue}${
                                          entry.timing.suffix
                                            ? ` ${entry.timing.suffix}`
                                            : ""
                                        }`
                                      : ""}
                                  </Text>
                                </BlockStack>
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                <InlineStack gap="100">
                                  {entry.flowOwned ? (
                                    <Badge>Klaviyo flow</Badge>
                                  ) : entry.enabled ? (
                                    <Badge tone="success">On</Badge>
                                  ) : (
                                    <Badge tone="critical">Off</Badge>
                                  )}
                                  {(entry.subject || entry.body) && (
                                    <Badge tone="info">Customized</Badge>
                                  )}
                                  {entry.critical && (
                                    <Badge tone="attention">Always on</Badge>
                                  )}
                                </InlineStack>
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                <Button
                                  variant="plain"
                                  size="slim"
                                  onClick={() =>
                                    setSearchParams(
                                      (prev) => {
                                        const next = new URLSearchParams(prev);
                                        next.set("tab", "activity");
                                        next.set("logTemplate", entry.template);
                                        return next;
                                      },
                                      { replace: true, preventScrollReset: true },
                                    )
                                  }
                                >
                                  {String(entry.sentCount)}
                                </Button>
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                {entry.flowOwned ? (
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    —
                                  </Text>
                                ) : (
                                  <Button
                                    size="slim"
                                    onClick={() => openEditor(entry)}
                                  >
                                    Edit
                                  </Button>
                                )}
                              </IndexTable.Cell>
                            </IndexTable.Row>
                          ))}
                        </IndexTable>
                      </Card>
                    ))}
                    <Card>
                      <BlockStack gap="200">
                        <Text as="h3" variant="headingMd">
                          Event-triggered flows (content lives in Klaviyo)
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          These metrics fire automatically at the moment the
                          event happens — build a flow on the metric to message
                          the customer; timing and copy are the flow&rsquo;s.
                        </Text>
                        <BlockStack gap="100">
                          {data.flows.map((flow) => (
                            <InlineStack key={flow.eventType} gap="200" wrap={false}>
                              <Box minWidth="260px">
                                <Text as="span" variant="bodySm" fontWeight="medium">
                                  {flow.metric}
                                </Text>
                              </Box>
                              <Text as="span" variant="bodySm" tone="subdued">
                                fires on {flow.eventType}
                              </Text>
                            </InlineStack>
                          ))}
                        </BlockStack>
                      </BlockStack>
                    </Card>
                  </BlockStack>
                ) : (
                  <ActivityTab data={data} setSearchParams={setSearchParams} />
                )}
              </Box>
            </Tabs>
          </Box>
        </Layout.Section>
      </Layout>

      {editing && (
        <Modal
          open
          onClose={() => setEditing(null)}
          title={editing.title}
          primaryAction={{
            content: "Save",
            onAction: saveEditing,
            loading: saving,
          }}
          secondaryActions={[
            { content: "Cancel", onAction: () => setEditing(null) },
          ]}
        >
          <Modal.Section>
            <BlockStack gap="400">
              <Text as="p" variant="bodySm" tone="subdued">
                {editing.trigger}
              </Text>
              {editing.disableable ? (
                <Checkbox
                  label="Send this email"
                  checked={enabled}
                  onChange={setEnabled}
                  helpText="Off = suppressed entirely (logged, never delivered)."
                />
              ) : (
                <Text as="p" variant="bodySm" tone="subdued">
                  This message cannot be disabled
                  {editing.critical ? " (critical delivery)" : ""}.
                </Text>
              )}
              {editing.timing && (
                <TextField
                  autoComplete="off"
                  label={`${editing.timing.label}${
                    editing.timing.suffix ? ` (${editing.timing.suffix})` : ""
                  }`}
                  value={timing}
                  onChange={setTiming}
                  error={editorErrors?.timing}
                  helpText={
                    editing.timing.kind === "intList"
                      ? "Comma-separated day offsets, e.g. 0, 3, 7 — shared by the whole notice ladder."
                      : undefined
                  }
                />
              )}
              {editing.customizable ? (
                <>
                  <TextField
                    autoComplete="off"
                    label="Subject"
                    value={subject}
                    onChange={setSubject}
                    placeholder="Leave empty to keep the built-in subject"
                    error={editorErrors?.subject}
                  />
                  <TextField
                    autoComplete="off"
                    label="Body"
                    value={body}
                    onChange={setBody}
                    multiline={8}
                    placeholder="Leave empty to keep the built-in body"
                    error={editorErrors?.body}
                    helpText="Plain text; line breaks are kept. {placeholders} are filled in per send."
                  />
                  <Box background="bg-surface-secondary" borderRadius="200" padding="300">
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" fontWeight="medium">
                        Placeholders for this email
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {[
                          ...editing.links.map((l) => `{${l}}`),
                          ...COMMON_PLACEHOLDERS,
                        ]
                          .filter((v, i, arr) => arr.indexOf(v) === i)
                          .join("  ")}
                      </Text>
                      {editing.links.includes("addon_url") && (
                        <Text as="p" variant="bodySm" tone="subdued">
                          {"{addon_url}"} adds the suggested product to the next
                          order in one click; {"{delay_1w_url}"} /{" "}
                          {"{delay_3w_url}"} push the charge back in one click —
                          both proven to reduce churn versus a plain manage
                          link.
                        </Text>
                      )}
                    </BlockStack>
                  </Box>
                </>
              ) : (
                <Text as="p" variant="bodySm" tone="subdued">
                  Content for this message is built in
                  {editing.channel === "SMS"
                    ? " (SMS copy lives in your Klaviyo flow)"
                    : ""}
                  .
                </Text>
              )}
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}

function ActivityTab({
  data,
  setSearchParams,
}: {
  data: LoaderData;
  setSearchParams: ReturnType<typeof useSearchParams>[1];
}) {
  const titleOf = (template: string): string =>
    data.entries.find((e) => e.template === template)?.title ?? template;

  return (
    <Card padding="0">
      <Box padding="400" paddingBlockEnd="200">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h3" variant="headingMd">
            Latest sends
          </Text>
          {data.logTemplate && (
            <Button
              size="slim"
              onClick={() =>
                setSearchParams(
                  (prev) => {
                    const next = new URLSearchParams(prev);
                    next.delete("logTemplate");
                    return next;
                  },
                  { replace: true, preventScrollReset: true },
                )
              }
            >
              Clear filter
            </Button>
          )}
        </InlineStack>
      </Box>
      <IndexTable
        resourceName={{ singular: "send", plural: "sends" }}
        itemCount={data.logRows.length}
        selectable={false}
        headings={[
          { title: "When" },
          { title: "Email" },
          { title: "Recipient" },
          { title: "Channel" },
          { title: "Status" },
        ]}
      >
        {data.logRows.map((row, index) => (
          <IndexTable.Row id={row.id} key={row.id} position={index}>
            <IndexTable.Cell>
              <Text as="span" variant="bodySm">
                {new Date(row.createdAt).toLocaleString()}
              </Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
              <BlockStack gap="050">
                <Text as="span" variant="bodySm" fontWeight="medium">
                  {titleOf(row.template)}
                </Text>
                {row.contractId && (
                  <PolarisLink url={`/app/subscribers/${row.contractId}`}>
                    <Text as="span" variant="bodySm">
                      View subscriber
                    </Text>
                  </PolarisLink>
                )}
              </BlockStack>
            </IndexTable.Cell>
            <IndexTable.Cell>
              <Text as="span" variant="bodySm">
                {row.email ?? row.phone ?? "—"}
              </Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
              <Text as="span" variant="bodySm">
                {row.channel === "KLAVIYO_EVENT" ? "Klaviyo" : row.channel}
              </Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
              <InlineStack gap="100">
                <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>
                {row.error && (
                  <Text as="span" variant="bodySm" tone="subdued">
                    {row.error.slice(0, 80)}
                  </Text>
                )}
              </InlineStack>
            </IndexTable.Cell>
          </IndexTable.Row>
        ))}
      </IndexTable>
      {data.logRows.length === 0 && (
        <Box padding="400">
          <Text as="p" variant="bodySm" tone="subdued">
            Nothing sent yet — sends will appear here the moment the first
            notification goes out.
          </Text>
        </Box>
      )}
    </Card>
  );
}
