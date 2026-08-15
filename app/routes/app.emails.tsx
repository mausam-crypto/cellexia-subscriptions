import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, SerializeFrom } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useSearchParams,
  useSubmit,
} from "@remix-run/react";
import type { ShouldRevalidateFunction } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  Collapsible,
  InlineGrid,
  InlineStack,
  IndexTable,
  Layout,
  Link as PolarisLink,
  Page,
  Select,
  Tabs,
  Text,
  TextField,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";

import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { getSetting, setSetting } from "~/lib/settings/settings.server";
import { settingsSchemas } from "~/lib/settings/registry.server";
import { logEvent } from "~/lib/events/log.server";
import { isKlaviyoConfigured } from "~/lib/klaviyo/client.server";
import { eventMetricEntries } from "~/lib/klaviyo/events-map.server";
import { TEMPLATES, isTemplateKey } from "~/lib/notifications/templates.server";
import {
  emailCatalogEntries,
  type CatalogTiming,
} from "~/lib/notifications/catalog.server";
import { renderTemplatePreview } from "~/lib/notifications/preview.server";
import { readCachedCoverage } from "~/lib/klaviyo/flows.server";
import {
  DEFAULT_EMAIL_DESIGN,
  normalizeEmailDesign,
  type EmailDesign,
} from "~/lib/notifications/format";

/**
 * Emails overview (v1.17.0) — every message the app sends, in one mental
 * model with three questions the page answers per row:
 *
 *   WHAT we send — the catalog, grouped by customer journey, each email
 *   opening a full editor (/app/emails/:template) with formatting, live
 *   preview and test send;
 *   WHO sends it — the per-template sender (Cellexia app vs Klaviyo flow,
 *   "auto" = the historical behavior), replacing the old opaque
 *   "flow-owned" split;
 *   WHEN it goes — the timing knobs (owned by the same settings groups the
 *   Settings page edits, shown inline).
 *
 * Plus the Design tab (brand kit driving the shared email shell) and the
 * Activity tab (NotificationLog sent log).
 *
 * Route shape (v1.25.0): this is a LEAF route. The setup wizard
 * (`app.emails_.setup.tsx`) and the per-template editor
 * (`app.emails_.$template.tsx`) use Remix's escaped flat-route names — same
 * URLs, but no longer nested under this page — so this loader (a dozen
 * settings reads + the sent log + a design preview render) runs only for
 * the overview itself, never on a child's document load or after a child
 * action. Tab switches (`?tab=`) don't re-run it either.
 */

const LOG_PAGE_SIZE = 100;

/**
 * Deterministic timestamp label (fixed locale + UTC): rendered on the
 * server AND re-rendered on hydration, so it must not depend on either
 * side's locale/timezone — a bare toLocaleString() here is a React
 * hydration mismatch.
 */
function formatUtcLabel(iso: string): string {
  return `${new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(iso))} UTC`;
}

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
    emailDesign,
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
    getSetting(shop.id, "emailDesign"),
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
      where: {
        shopId: shop.id,
        // CLAIMED rows are transient confirmation-bridge claim markers
        // (confirmations.server.ts), not sends — deleted after delivery,
        // and never shown even if a crash strands one.
        status: { not: "CLAIMED" },
        ...(logTemplate ? { template: logTemplate } : {}),
      },
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
      customized: Boolean(override?.subject || override?.body),
      sender: (override?.sender ?? "auto") as "auto" | "app" | "klaviyo",
      timingValue: timingValue(entry.timing),
      sentCount: sentCount.get(entry.template) ?? 0,
    };
  });

  // Initial Design-tab preview: the saved design over the flagship email.
  const designPreview = await renderTemplatePreview({
    template: "upcoming_order",
    locale: "en",
    subject: emails.templates.upcoming_order?.subject ?? "",
    body: emails.templates.upcoming_order?.body ?? "",
    shopId: shop.id,
  });

  // Klaviyo flow coverage — the CACHED verdict only (the setup page and the
  // daily alert check are the ones that talk to Klaviyo). Rows whose
  // templates are app-delivered or turned off don't need a flow and stay
  // out of the numerator/denominator.
  const coverage = await readCachedCoverage(shop.id);
  const flowRows = coverage.rows.filter(
    (r) => r.status !== "app_delivers" && r.status !== "off",
  );
  const coverageSummary = {
    checkedAtLabel: coverage.checkedAt ? formatUtcLabel(coverage.checkedAt) : null,
    total: flowRows.length,
    live: flowRows.filter((r) => r.status === "live").length,
  };

  return json({
    entries,
    flows: eventMetricEntries(),
    klaviyoConfigured,
    coverageSummary,
    logRows,
    logTemplate,
    design: normalizeEmailDesign(emailDesign),
    designPreviewHtml: designPreview.html,
  });
};

interface ActionData {
  intent: string;
  ok: boolean;
  toast?: string;
  errors?: Record<string, string>;
  previewHtml?: string;
}

function actorFromSession(session: {
  onlineAccessInfo?: { associated_user?: { email?: string | null } | null } | null;
  shop: string;
}): string {
  return (
    session.onlineAccessInfo?.associated_user?.email ?? `admin@${session.shop}`
  );
}

/** Parses the posted brand-kit draft into a full EmailDesign candidate. */
function designFromForm(formData: FormData): Record<string, unknown> {
  const value = (name: string): string => String(formData.get(`design_${name}`) ?? "");
  return {
    headerStyle: value("headerStyle"),
    wordmark: value("wordmark"),
    logoUrl: value("logoUrl").trim(),
    logoWidth: Number(value("logoWidth") || DEFAULT_EMAIL_DESIGN.logoWidth),
    fontFamily: value("fontFamily"),
    backgroundColor: value("backgroundColor").trim(),
    cardBackground: value("cardBackground").trim(),
    cardBorderColor: value("cardBorderColor").trim(),
    textColor: value("textColor").trim(),
    mutedColor: value("mutedColor").trim(),
    linkColor: value("linkColor").trim(),
    buttonColor: value("buttonColor").trim(),
    buttonTextColor: value("buttonTextColor").trim(),
    footerText: value("footerText"),
    footerNote: value("footerNote"),
  };
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

  // ── Design-tab live preview (no persistence) ─────────────────────────────
  if (intent === "preview-design") {
    const emails = await getSetting(shop.id, "emails");
    const preview = await renderTemplatePreview({
      template: "upcoming_order",
      locale: "en",
      subject: emails.templates.upcoming_order?.subject ?? "",
      body: emails.templates.upcoming_order?.body ?? "",
      design: normalizeEmailDesign(designFromForm(formData)),
    });
    return json<ActionData>({ intent, ok: true, previewHtml: preview.html });
  }

  if (intent === "save-design" || intent === "reset-design") {
    const candidate =
      intent === "reset-design"
        ? (DEFAULT_EMAIL_DESIGN as unknown as Record<string, unknown>)
        : designFromForm(formData);
    const parsed = settingsSchemas.emailDesign.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return json<ActionData>(
        {
          intent,
          ok: false,
          toast: `${issue?.path.join(".") ?? "design"}: ${issue?.message ?? "invalid value"}`,
        },
        { status: 422 },
      );
    }
    const previous = await getSetting(shop.id, "emailDesign");
    if (JSON.stringify(parsed.data) !== JSON.stringify(previous)) {
      await setSetting(shop.id, "emailDesign", parsed.data, actor);
      await logEvent({
        shopId: shop.id,
        type: "admin.action",
        source: "ADMIN",
        actor,
        payload: {
          action: "settings_updated",
          key: "emailDesign",
          value: parsed.data,
          previous,
        },
      });
    }
    return json<ActionData>({
      intent,
      ok: true,
      toast:
        intent === "reset-design" ? "Design reset to defaults" : "Email design saved",
    });
  }

  return json<ActionData>({ intent, ok: false, toast: "Unknown action" }, { status: 400 });
};

// ── UI ───────────────────────────────────────────────────────────────────────

type LoaderData = SerializeFrom<typeof loader>;
type EmailEntry = LoaderData["entries"][number];

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

function senderBadge(
  entry: EmailEntry,
  klaviyoConfigured: boolean,
): { label: string; tone?: "success" | "info" } {
  if (entry.dormant) return { label: "—" };
  if (!entry.metric) return { label: "Cellexia" };
  if (entry.channel === "SMS") return { label: "Klaviyo flow" };
  if (entry.critical) {
    return entry.sender === "app"
      ? { label: "Cellexia", tone: "success" }
      : { label: "Cellexia + Klaviyo" };
  }
  if (entry.confirmationEvent) {
    return entry.sender === "app"
      ? { label: "Cellexia", tone: "success" }
      : { label: "Klaviyo flow" };
  }
  if (entry.sender === "app") return { label: "Cellexia", tone: "success" };
  if (entry.sender === "klaviyo") return { label: "Klaviyo flow" };
  return klaviyoConfigured
    ? { label: "Auto · Klaviyo flow" }
    : { label: "Auto · Cellexia" };
}

/** True when the two search strings differ only in the `tab` parameter (or not at all). */
function onlyTabDiffers(a: URLSearchParams, b: URLSearchParams): boolean {
  const strip = (params: URLSearchParams): string => {
    const copy = new URLSearchParams(params);
    copy.delete("tab");
    copy.sort();
    return copy.toString();
  };
  return strip(a) === strip(b);
}

/**
 * Preview posts render draft copy/design and change no state — re-running
 * this route's heavy loader (settings + log queries + a preview render) on
 * every debounced keystroke would only slow the editor down. Likewise a
 * tab switch (`?tab=design|activity`) is pure client state: the loader
 * already returned every tab's data. `?logTemplate=` DOES change the
 * loader's query and keeps the default.
 */
export const shouldRevalidate: ShouldRevalidateFunction = ({
  formData,
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}) => {
  const intent = formData?.get("intent");
  if (intent === "preview" || intent === "preview-design") return false;
  if (
    !formData &&
    currentUrl.pathname === nextUrl.pathname &&
    onlyTabDiffers(currentUrl.searchParams, nextUrl.searchParams)
  ) {
    return false;
  }
  return defaultShouldRevalidate;
};

export default function EmailsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam = searchParams.get("tab");
  const selectedTab = tabParam === "design" ? 1 : tabParam === "activity" ? 2 : 0;

  useEffect(() => {
    if (actionData?.toast) {
      shopify.toast.show(actionData.toast, { isError: !actionData.ok });
    }
  }, [actionData, shopify]);

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
    { id: "design", content: "Design" },
    { id: "activity", content: "Sent log" },
  ];

  return (
    <Page
      title="Emails"
      subtitle="Every message this app sends — content, design, timing and one-click actions, with a live preview of each."
    >
      <Layout>
        <Layout.Section>
          {!data.klaviyoConfigured && (
            <Banner tone="info" title="Klaviyo is not connected">
              <p>
                That&rsquo;s fine — reminders, payment and system emails are
                sent by Cellexia itself through your email transport
                (Settings → Email delivery), exactly as previewed here.
                Order-change confirmations (skip, pause, cancel, …) default
                to Klaviyo flows: without Klaviyo they are not sent unless
                you open one and switch its sender to &ldquo;Cellexia sends
                it&rdquo;. SMS also needs Klaviyo.
              </p>
            </Banner>
          )}
          <Box paddingBlockStart={data.klaviyoConfigured ? "0" : "400"}>
            <Tabs
              tabs={tabs}
              selected={selectedTab}
              onSelect={(index) => {
                setSearchParams(
                  (prev) => {
                    const next = new URLSearchParams(prev);
                    if (index === 1) next.set("tab", "design");
                    else if (index === 2) next.set("tab", "activity");
                    else next.delete("tab");
                    return next;
                  },
                  { replace: true, preventScrollReset: true },
                );
              }}
            >
              <Box paddingBlockStart="400">
                {selectedTab === 0 ? (
                  <CatalogTab data={data} grouped={grouped} />
                ) : selectedTab === 1 ? (
                  <DesignTab data={data} />
                ) : (
                  <ActivityTab data={data} setSearchParams={setSearchParams} />
                )}
              </Box>
            </Tabs>
          </Box>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function CatalogTab({
  data,
  grouped,
}: {
  data: LoaderData;
  grouped: Map<EmailEntry["group"], EmailEntry[]>;
}) {
  const [, setSearchParams] = useSearchParams();
  const [showFlows, setShowFlows] = useState(false);

  const cov = data.coverageSummary;
  // The cached verdict is only meaningful while Klaviyo is connected — a
  // disconnected shop delivers via SMTP, and a weeks-old "20 of 26 live"
  // line next to the "not connected" banner would be nonsense.
  const showCoverage = cov.total > 0 && data.klaviyoConfigured;

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="200">
          <InlineStack align="space-between" blockAlign="center" wrap>
            <BlockStack gap="050">
              <Text as="h3" variant="headingMd">
                Klaviyo delivery
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {showCoverage
                  ? `${cov.live} of ${cov.total} emails are delivered by a live Klaviyo flow` +
                    (cov.checkedAtLabel ? ` · checked ${cov.checkedAtLabel}` : "")
                  : data.klaviyoConfigured
                    ? "Let Klaviyo deliver every email for the best inbox placement — the guided setup builds all the flows for you, no technical knowledge needed."
                    : "Optional: connect Klaviyo and the guided setup builds every delivery flow for you — best-in-class deliverability, zero technical knowledge needed."}
              </Text>
            </BlockStack>
            <Button
              url="/app/emails/setup"
              variant={showCoverage && cov.live === cov.total ? undefined : "primary"}
            >
              {showCoverage ? "Open delivery checklist" : "Guided Klaviyo setup"}
            </Button>
          </InlineStack>
          {showCoverage && cov.live < cov.total && (
            <Banner tone="warning">
              <p>
                {cov.total - cov.live} email
                {cov.total - cov.live === 1 ? " is" : "s are"} not covered by a
                live flow — customers receive nothing for those moments. The
                checklist shows which and fixes it in one click.
              </p>
            </Banner>
          )}
        </BlockStack>
      </Card>
      <Card>
        <BlockStack gap="200">
          <Text as="h3" variant="headingMd">
            How your emails work
          </Text>
          <Text as="p" variant="bodySm">
            Each row is one message with three simple controls: <b>what</b> it
            says (open it to edit with formatting and a live preview),{" "}
            <b>who</b> sends it — Cellexia directly, or your Klaviyo flow —
            and <b>when</b> it goes out. &ldquo;Auto&rdquo; keeps the
            behavior you have today: Klaviyo delivers while it is connected,
            Cellexia delivers otherwise.
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Emails marked &ldquo;Klaviyo flow&rdquo; are delivered by a flow
            you build on the matching event — copy written here still rides
            along as{" "}
            <code>{"{{ event.content_html }}"}</code> so a flow email can stay
            identical to the preview. See docs/KLAVIYO_SETUP.md for recipes.
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
              { title: "Sent by" },
              { title: "Trigger & timing" },
              { title: "Status" },
              { title: "Sent" },
              { title: "" },
            ]}
          >
            {entries.map((entry, index) => {
              const sender = senderBadge(entry, data.klaviyoConfigured);
              return (
                <IndexTable.Row
                  id={entry.template}
                  key={entry.template}
                  position={index}
                >
                  <IndexTable.Cell>
                    <BlockStack gap="050">
                      {entry.dormant ? (
                        <Text as="span" fontWeight="semibold">
                          {entry.title}
                        </Text>
                      ) : (
                        <PolarisLink url={`/app/emails/${entry.template}`}>
                          <Text as="span" fontWeight="semibold">
                            {entry.title}
                          </Text>
                        </PolarisLink>
                      )}
                      <Text as="span" variant="bodySm" tone="subdued">
                        {entry.channel === "SMS" ? "SMS" : "Email"}
                        {entry.metric ? ` · ${entry.metric}` : " · direct only"}
                      </Text>
                    </BlockStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge tone={sender.tone}>{sender.label}</Badge>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <BlockStack gap="050">
                      <Text as="span" variant="bodySm">
                        {entry.trigger}
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {entry.timing
                          ? `${entry.timing.label.toLowerCase()} ${entry.timingValue}${
                              entry.timing.suffix ? ` ${entry.timing.suffix}` : ""
                            }`
                          : entry.sentBy}
                      </Text>
                    </BlockStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <InlineStack gap="100">
                      {entry.dormant ? (
                        <Badge>Not active yet</Badge>
                      ) : entry.enabled ? (
                        <Badge tone="success">On</Badge>
                      ) : (
                        <Badge tone="critical">Off</Badge>
                      )}
                      {entry.customized && <Badge tone="info">Customized</Badge>}
                      {entry.critical && <Badge tone="attention">Always on</Badge>}
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
                    {entry.dormant ? (
                      <Text as="span" variant="bodySm" tone="subdued">
                        —
                      </Text>
                    ) : (
                      <Button size="slim" url={`/app/emails/${entry.template}`}>
                        Edit
                      </Button>
                    )}
                  </IndexTable.Cell>
                </IndexTable.Row>
              );
            })}
          </IndexTable>
        </Card>
      ))}
      <Card>
        <BlockStack gap="200">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h3" variant="headingMd">
              Klaviyo event feed (advanced)
            </Text>
            <Button
              variant="plain"
              size="slim"
              disclosure={showFlows ? "up" : "down"}
              onClick={() => setShowFlows((v) => !v)}
            >
              {showFlows ? "Hide" : "Show"}
            </Button>
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            Every subscription moment also emits a Klaviyo event — that is
            what powers segments and any flows you choose to build. You do
            NOT need flows for the emails above unless a row&rsquo;s sender
            says &ldquo;Klaviyo flow&rdquo;.
          </Text>
          <Collapsible id="klaviyo-flows" open={showFlows}>
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
          </Collapsible>
        </BlockStack>
      </Card>
    </BlockStack>
  );
}

// ── Design tab ───────────────────────────────────────────────────────────────

const COLOR_FIELDS: Array<{ key: keyof EmailDesign; label: string }> = [
  { key: "backgroundColor", label: "Page background" },
  { key: "cardBackground", label: "Card background" },
  { key: "cardBorderColor", label: "Card border" },
  { key: "textColor", label: "Text" },
  { key: "mutedColor", label: "Muted text & footer" },
  { key: "linkColor", label: "Links" },
  { key: "buttonColor", label: "Button" },
  { key: "buttonTextColor", label: "Button text" },
];

function DesignTab({ data }: { data: LoaderData }) {
  const submit = useSubmit();
  const navigation = useNavigation();
  const previewFetcher = useFetcher<ActionData>();
  const [draft, setDraft] = useState<EmailDesign>(data.design);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");

  const baseline = JSON.stringify(data.design);
  const dirty = JSON.stringify(draft) !== baseline;
  const navIntent = navigation.formData?.get("intent");
  const saving = navigation.state === "submitting" && navIntent === "save-design";
  const resetting =
    navigation.state === "submitting" && navIntent === "reset-design";

  // Re-init the draft after a successful save/reset revalidation.
  useEffect(() => {
    setDraft(data.design);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseline]);

  const set = useCallback(<K extends keyof EmailDesign>(key: K, value: EmailDesign[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const designForm = useCallback(
    (intent: string): FormData => {
      const form = new FormData();
      form.set("intent", intent);
      for (const [key, value] of Object.entries(draft)) {
        form.set(`design_${key}`, String(value));
      }
      return form;
    },
    [draft],
  );

  // Debounced live preview of the draft design. Only trust the fetcher's
  // draft render while the draft is actually dirty — after a save/reset the
  // loader's fresh saved-design render must win, or "Reset to defaults"
  // would keep showing the pre-reset colors from the fetcher's last POST.
  const previewHtml = dirty
    ? (previewFetcher.data?.previewHtml ?? data.designPreviewHtml)
    : data.designPreviewHtml;
  useEffect(() => {
    if (!dirty) return;
    const handle = setTimeout(() => {
      previewFetcher.submit(designForm("preview-design"), { method: "post" });
    }, 350);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(draft)]);

  const previewWidth = device === "mobile" ? 375 : 600;

  return (
    <InlineGrid columns={{ xs: 1, lg: 2 }} gap="400" alignItems="start">
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              Brand kit
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              One design for every email — direct sends and the rendered
              content your Klaviyo flows carry both use it. Defaults are the
              classic Cellexia look.
            </Text>
            <Select
              label="Header"
              options={[
                { label: "Wordmark text", value: "wordmark" },
                { label: "Logo image", value: "logo" },
                { label: "None", value: "none" },
              ]}
              value={draft.headerStyle}
              onChange={(v) => set("headerStyle", v as EmailDesign["headerStyle"])}
            />
            {draft.headerStyle === "wordmark" && (
              <TextField
                autoComplete="off"
                label="Wordmark"
                value={draft.wordmark}
                onChange={(v) => set("wordmark", v)}
              />
            )}
            {draft.headerStyle === "logo" && (
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                <TextField
                  autoComplete="off"
                  label="Logo URL (https)"
                  value={draft.logoUrl}
                  onChange={(v) => set("logoUrl", v)}
                  placeholder="https://cdn.shopify.com/…/logo.png"
                />
                <TextField
                  autoComplete="off"
                  label="Logo width (px)"
                  type="number"
                  value={String(draft.logoWidth)}
                  onChange={(v) => set("logoWidth", Number(v) || 140)}
                />
              </InlineGrid>
            )}
            <Select
              label="Font"
              options={[
                { label: "Serif (Georgia — the classic look)", value: "serif" },
                { label: "Sans-serif (system)", value: "sans" },
              ]}
              value={draft.fontFamily}
              onChange={(v) => set("fontFamily", v as EmailDesign["fontFamily"])}
            />
          </BlockStack>
        </Card>
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              Colors
            </Text>
            <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
              {COLOR_FIELDS.map(({ key, label }) => (
                <TextField
                  key={key}
                  autoComplete="off"
                  label={label}
                  value={String(draft[key])}
                  onChange={(v) => set(key, v as never)}
                  prefix={
                    <span
                      style={{
                        display: "inline-block",
                        width: 16,
                        height: 16,
                        borderRadius: 4,
                        border: "1px solid rgba(0,0,0,.2)",
                        background: /^#[0-9a-fA-F]{6}$/.test(String(draft[key]))
                          ? String(draft[key])
                          : "transparent",
                      }}
                    />
                  }
                  helpText="Hex, e.g. #1a1a1a"
                />
              ))}
            </InlineGrid>
          </BlockStack>
        </Card>
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              Footer
            </Text>
            <TextField
              autoComplete="off"
              label="Footer line"
              value={draft.footerText}
              onChange={(v) => set("footerText", v)}
            />
            <TextField
              autoComplete="off"
              label="Footer note"
              value={draft.footerNote}
              onChange={(v) => set("footerNote", v)}
            />
            <InlineStack gap="200">
              <Button
                variant="primary"
                loading={saving}
                disabled={!dirty}
                onClick={() => submit(designForm("save-design"), { method: "post" })}
              >
                Save design
              </Button>
              <Button
                loading={resetting}
                onClick={() => submit(designForm("reset-design"), { method: "post" })}
              >
                Reset to defaults
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>
      </BlockStack>
      <div style={{ position: "sticky", top: "16px" }}>
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h3" variant="headingMd">
                Live preview
              </Text>
              <ButtonGroup variant="segmented">
                <Button
                  size="slim"
                  pressed={device === "desktop"}
                  onClick={() => setDevice("desktop")}
                >
                  Desktop
                </Button>
                <Button
                  size="slim"
                  pressed={device === "mobile"}
                  onClick={() => setDevice("mobile")}
                >
                  Mobile
                </Button>
              </ButtonGroup>
            </InlineStack>
            <Box borderWidth="025" borderColor="border" borderRadius="200">
              <div
                style={{
                  maxWidth: previewWidth,
                  margin: "0 auto",
                  transition: "max-width .2s ease",
                }}
              >
                <iframe
                  title="Email design preview"
                  sandbox=""
                  srcDoc={previewHtml}
                  style={{
                    display: "block",
                    width: "100%",
                    height: 620,
                    border: "none",
                    background: "#fff",
                  }}
                />
              </div>
            </Box>
            <Text as="p" variant="bodySm" tone="subdued">
              Shown on the upcoming-order reminder with sample data; every
              email uses this shell.
            </Text>
          </BlockStack>
        </Card>
      </div>
    </InlineGrid>
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
