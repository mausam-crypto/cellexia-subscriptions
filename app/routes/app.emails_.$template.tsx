import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, SerializeFrom } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useFetcher,
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
  ButtonGroup,
  Card,
  Checkbox,
  ChoiceList,
  Collapsible,
  Divider,
  InlineGrid,
  InlineStack,
  Page,
  Select,
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
import { SUPPORTED_LOCALES } from "~/lib/i18n/i18n.server";
import { TEMPLATES, isTemplateKey } from "~/lib/notifications/templates.server";
import { EMAIL_CATALOG } from "~/lib/notifications/catalog.server";
import { renderTemplatePreview } from "~/lib/notifications/preview.server";
import { resolveMailConfig, sendEmail } from "~/lib/notifications/mailer.server";

/**
 * Email editor (v1.17.0) — one page per template: content with formatting,
 * live rendered preview (the REAL renderEmail pipeline on sample data),
 * sender choice, timing, and a test send. The overview lives at /app/emails.
 */

const SENDER_VALUES = ["auto", "app", "klaviyo"] as const;
type SenderValue = (typeof SENDER_VALUES)[number];

function actorFromSession(session: {
  onlineAccessInfo?: { associated_user?: { email?: string | null } | null } | null;
  shop: string;
}): string {
  return (
    session.onlineAccessInfo?.associated_user?.email ?? `admin@${session.shop}`
  );
}

/** Sender choice applies where a real alternative exists. */
function senderConfigurable(template: string): boolean {
  if (!isTemplateKey(template)) return false;
  const tmpl = TEMPLATES[template];
  const entry = EMAIL_CATALOG[template];
  if (entry.dormant) return false;
  if (!tmpl.klaviyoMetric) return false; // system mail: always direct
  if (tmpl.channel === "SMS") return false; // no SMTP transport for SMS
  return true;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }
  const template = params.template ?? "";
  if (!isTemplateKey(template)) {
    throw new Response("Unknown email template", { status: 404 });
  }
  const tmpl = TEMPLATES[template];
  const entry = EMAIL_CATALOG[template];

  const [emails, klaviyoConfigured, sentCount] = await Promise.all([
    getSetting(shop.id, "emails"),
    isKlaviyoConfigured(shop.id).catch(() => false),
    prisma.notificationLog.count({
      where: { shopId: shop.id, template, status: "SENT" },
    }),
  ]);
  const override = emails.templates[template];

  let timingValue = "";
  if (entry.timing) {
    const group = (await getSetting(
      shop.id,
      entry.timing.settingsKey,
    )) as unknown as Record<string, unknown>;
    const value = group?.[entry.timing.path];
    timingValue = Array.isArray(value)
      ? value.join(", ")
      : value == null
        ? ""
        : String(value);
  }

  const preview = await renderTemplatePreview({
    template,
    locale: "en",
    subject: override?.subject ?? "",
    body: override?.body ?? "",
    shopId: shop.id,
  });

  return json({
    template,
    title: entry.title,
    trigger: entry.trigger,
    sentBy: entry.sentBy,
    group: entry.group,
    channel: tmpl.channel,
    metric: tmpl.klaviyoMetric,
    critical: tmpl.critical,
    customizable: entry.customizable,
    disableable: entry.disableable,
    dormant: entry.dormant ?? false,
    confirmationEvent: entry.confirmationEvent ?? null,
    links: entry.links,
    timing: entry.timing,
    timingValue,
    enabled: override?.enabled !== false,
    subject: override?.subject ?? "",
    body: override?.body ?? "",
    sender: (override?.sender ?? "auto") as SenderValue,
    senderConfigurable: senderConfigurable(template),
    klaviyoConfigured,
    sentCount,
    locales: SUPPORTED_LOCALES,
    actorEmail: actorFromSession(session),
    initialPreview: {
      subject: preview.subject,
      html: preview.html,
      text: preview.text,
    },
    sampleVars: Object.fromEntries(
      Object.entries(preview.sampleVars).map(([k, v]) => [k, String(v)]),
    ),
  });
};

interface ActionData {
  intent: string;
  ok: boolean;
  toast?: string;
  errors?: Record<string, string>;
  preview?: { subject: string; html: string; text: string };
}

/**
 * Preview posts render draft copy and change no state — skip the loader
 * re-run that Remix would otherwise do after every debounced keystroke.
 * A test send changes no state either (it never writes NotificationLog),
 * so it skips the re-run too; `save` keeps the default because the
 * baseline-resync effect needs the fresh loader data. (Since v1.25.0 this
 * route is no longer nested under the Emails overview — escaped file name
 * — so the overview's heavy loader is never involved here at all.)
 */
export const shouldRevalidate: ShouldRevalidateFunction = ({
  formData,
  defaultShouldRevalidate,
}) => {
  const intent = formData?.get("intent");
  if (intent === "preview" || intent === "send-test") return false;
  return defaultShouldRevalidate;
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }
  const template = params.template ?? "";
  if (!isTemplateKey(template)) {
    throw new Response("Unknown email template", { status: 404 });
  }
  const tmpl = TEMPLATES[template];
  const catalog = EMAIL_CATALOG[template];
  const actor = actorFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  // ── Live preview (no persistence) ────────────────────────────────────────
  if (intent === "preview") {
    const preview = await renderTemplatePreview({
      template,
      locale: String(formData.get("locale") ?? "en"),
      subject: catalog.customizable ? String(formData.get("subject") ?? "") : "",
      body: catalog.customizable ? String(formData.get("body") ?? "") : "",
      shopId: shop.id,
    });
    return json<ActionData>({
      intent,
      ok: true,
      preview: {
        subject: preview.subject,
        html: preview.html,
        text: preview.text,
      },
    });
  }

  // ── Test send (direct SMTP, never logged in NotificationLog) ─────────────
  if (intent === "send-test") {
    if (tmpl.channel === "SMS") {
      return json<ActionData>(
        { intent, ok: false, toast: "SMS templates have no email test send" },
        { status: 400 },
      );
    }
    const to = String(formData.get("to") ?? "").trim();
    if (!to.includes("@")) {
      return json<ActionData>(
        { intent, ok: false, errors: { to: "Enter an email address" } },
        { status: 422 },
      );
    }
    const preview = await renderTemplatePreview({
      template,
      locale: String(formData.get("locale") ?? "en"),
      subject: catalog.customizable ? String(formData.get("subject") ?? "") : "",
      body: catalog.customizable ? String(formData.get("body") ?? "") : "",
      shopId: shop.id,
    });
    try {
      await sendEmail({
        shopId: shop.id,
        to,
        subject: `[Test] ${preview.subject}`,
        html: preview.html,
      });
    } catch (err) {
      return json<ActionData>(
        {
          intent,
          ok: false,
          toast: `Test send failed: ${err instanceof Error ? err.message : String(err)}`,
        },
        { status: 502 },
      );
    }
    const config = await resolveMailConfig(shop.id);
    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "ADMIN",
      actor,
      payload: { action: "email_test_sent", template, to },
    });
    return json<ActionData>({
      intent,
      ok: true,
      toast:
        config.provider === "console"
          ? "Test rendered to the server console (no SMTP transport is configured)"
          : `Test email sent to ${to}`,
    });
  }

  if (intent !== "save") {
    return json<ActionData>(
      { intent, ok: false, toast: "Unknown action" },
      { status: 400 },
    );
  }

  // ── Save: content + enabled + sender → `emails`; timing → owning group ───
  if (catalog.dormant) {
    return json<ActionData>(
      { intent, ok: false, toast: "This template is not active yet" },
      { status: 400 },
    );
  }

  const errors: Record<string, string> = {};
  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const enabledRaw = String(formData.get("enabled") ?? "true");
  const enabled = catalog.disableable ? enabledRaw === "true" : true;
  const senderRaw = String(formData.get("sender") ?? "auto");
  let sender: SenderValue =
    senderConfigurable(template) &&
    (SENDER_VALUES as readonly string[]).includes(senderRaw)
      ? (senderRaw as SenderValue)
      : "auto";
  // Critical templates always deliver via direct SMTP; "klaviyo" would
  // behave exactly like "auto" (the editor no longer offers it) — normalize
  // so a stored value never misdescribes behavior.
  if (tmpl.critical && sender === "klaviyo") sender = "auto";

  if (!catalog.customizable && (subject !== "" || body !== "")) {
    errors.subject = "This system email keeps its built-in content";
  }
  if (subject.length > 300) errors.subject = "Keep the subject under 300 characters";
  if (body.length > 10_000) errors.body = "Keep the body under 10 000 characters";

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
      // parts can be empty when the input is only separators ("," / " , ") —
      // without this guard that would silently persist an EMPTY ladder.
      if (parts.length === 0 || values.some((v) => !Number.isInteger(v))) {
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
        errors.timing = parsed.error.issues[0]?.message ?? "Invalid timing value";
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
    return json<ActionData>({ intent, ok: false, errors }, { status: 422 });
  }

  const previousEmails = await getSetting(shop.id, "emails");
  const nextTemplates = { ...previousEmails.templates };
  if (enabled && subject === "" && body === "" && sender === "auto") {
    // Fully default again — drop the row instead of storing an empty husk.
    delete nextTemplates[template];
  } else {
    nextTemplates[template] = { enabled, subject, body, sender };
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
    await setSetting(shop.id, timingChange.key, timingChange.value as never, actor);
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

  return json<ActionData>({ intent, ok: true, toast: `${catalog.title} saved` });
};

// ── UI ───────────────────────────────────────────────────────────────────────

type LoaderData = SerializeFrom<typeof loader>;

const EDITOR_CSS = `
.cxadm-body-editor {
  width: 100%;
  min-height: 260px;
  padding: 8px 12px;
  border: 1px solid var(--p-color-border, #8a8a8a);
  border-radius: 8px;
  font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: inherit;
  background: var(--p-color-bg-surface, #fff);
  resize: vertical;
  box-sizing: border-box;
}
.cxadm-body-editor:focus {
  outline: 2px solid var(--p-color-border-focus, #005bd3);
  outline-offset: 1px;
}
.cxadm-preview-frame {
  display: block;
  width: 100%;
  height: 620px;
  border: none;
  background: #fff;
}
.cxadm-chip {
  border: none;
  background: var(--p-color-bg-surface-secondary, #f1f1f1);
  border-radius: 6px;
  padding: 2px 8px;
  font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
  cursor: pointer;
}
.cxadm-chip:hover { background: var(--p-color-bg-surface-tertiary, #e5e5e5); }
`;

export default function EmailEditorPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const navigation = useNavigation();
  const previewFetcher = useFetcher<ActionData>();

  const [subject, setSubject] = useState(data.subject);
  const [body, setBody] = useState(data.body);
  const [enabled, setEnabled] = useState(data.enabled);
  const [sender, setSender] = useState<SenderValue>(data.sender);
  const [timing, setTiming] = useState(data.timingValue);
  const [locale, setLocale] = useState("en");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [showText, setShowText] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [testTo, setTestTo] = useState(data.actorEmail);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const navIntent = navigation.formData?.get("intent");
  const saving = navigation.state === "submitting" && navIntent === "save";
  const testing = navigation.state === "submitting" && navIntent === "send-test";

  const dirty =
    subject !== data.subject ||
    body !== data.body ||
    enabled !== data.enabled ||
    sender !== data.sender ||
    timing !== data.timingValue;

  useEffect(() => {
    if (actionData?.toast) {
      shopify.toast.show(actionData.toast, { isError: !actionData.ok });
    }
  }, [actionData, shopify]);

  // Re-sync local state after a successful save's revalidation: the action
  // normalizes (trim, intList reformatted "0, 3, 7"), and without this the
  // page would stay dirty forever with a live Save button after saving.
  const baseline = JSON.stringify([
    data.subject,
    data.body,
    data.enabled,
    data.sender,
    data.timingValue,
  ]);
  useEffect(() => {
    setSubject(data.subject);
    setBody(data.body);
    setEnabled(data.enabled);
    setSender(data.sender);
    setTiming(data.timingValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseline]);

  // Live preview: debounce drafts through the server renderer — the preview
  // pane always shows renderEmail's real output, never a client replica.
  // The mount-time run is skipped: data.initialPreview already holds that
  // exact render.
  const preview = previewFetcher.data?.preview ?? data.initialPreview;
  const firstPreviewRun = useRef(true);
  useEffect(() => {
    if (firstPreviewRun.current) {
      firstPreviewRun.current = false;
      return;
    }
    const handle = setTimeout(() => {
      const form = new FormData();
      form.set("intent", "preview");
      form.set("subject", subject);
      form.set("body", body);
      form.set("locale", locale);
      previewFetcher.submit(form, { method: "post" });
    }, 350);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject, body, locale]);

  const save = useCallback(() => {
    const form = new FormData();
    form.set("intent", "save");
    form.set("subject", subject);
    form.set("body", body);
    form.set("enabled", String(enabled));
    form.set("sender", sender);
    form.set("timing", timing);
    submit(form, { method: "post" });
  }, [subject, body, enabled, sender, timing, submit]);

  const sendTest = useCallback(() => {
    const form = new FormData();
    form.set("intent", "send-test");
    form.set("to", testTo);
    form.set("subject", subject);
    form.set("body", body);
    form.set("locale", locale);
    submit(form, { method: "post" });
  }, [testTo, subject, body, locale, submit]);

  /** Wraps the current selection (or inserts a template) in the body. */
  const applyFormat = useCallback(
    (kind: "bold" | "italic" | "link" | "button" | "list" | "divider" | "heading") => {
      const el = bodyRef.current;
      const start = el?.selectionStart ?? body.length;
      const end = el?.selectionEnd ?? body.length;
      const selected = body.slice(start, end);
      let insert = "";
      let cursorTo = start;
      switch (kind) {
        case "bold":
          insert = `**${selected || "bold text"}**`;
          cursorTo = start + insert.length;
          break;
        case "italic":
          insert = `*${selected || "italic text"}*`;
          cursorTo = start + insert.length;
          break;
        case "link":
          insert = `[${selected || "link text"}](https://)`;
          cursorTo = start + insert.length - 1;
          break;
        case "button":
          insert = `\n[button:${selected || "Manage subscription"}]({portal_url})\n`;
          cursorTo = start + insert.length;
          break;
        case "list":
          insert = selected
            ? selected
                .split("\n")
                .map((l) => (l.trim() ? `- ${l}` : l))
                .join("\n")
            : "- First point\n- Second point";
          cursorTo = start + insert.length;
          break;
        case "divider":
          insert = "\n---\n";
          cursorTo = start + insert.length;
          break;
        case "heading":
          insert = `## ${selected || "Heading"}`;
          cursorTo = start + insert.length;
          break;
      }
      const next = body.slice(0, start) + insert + body.slice(end);
      setBody(next);
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(cursorTo, cursorTo);
      });
    },
    [body],
  );

  const insertPlaceholder = useCallback(
    (name: string) => {
      const el = bodyRef.current;
      const start = el?.selectionStart ?? body.length;
      const end = el?.selectionEnd ?? body.length;
      const token = `{${name}}`;
      const next = body.slice(0, start) + token + body.slice(end);
      setBody(next);
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(start + token.length, start + token.length);
      });
    },
    [body],
  );

  const placeholders = useMemo(() => {
    const fromLinks = data.links.map((l) => l);
    const common = [
      "portal_url",
      "first_name",
      "total_estimate",
      "next_date",
      "items_summary",
      "frequency",
      "cta",
    ];
    return [...new Set([...fromLinks, ...common])];
  }, [data.links]);

  const senderChoices = useMemo(() => {
    if (data.critical) {
      // Critical mail always delivers via direct SMTP regardless of sender
      // (send.server.ts) — "klaviyo" would behave exactly like "auto", so
      // it is not offered, and no choice can suppress delivery.
      return [
        {
          label: "Auto (recommended)",
          value: "auto",
          helpText:
            "The app always delivers this critical email directly, and also fires the Klaviyo event so a flow can add its own touch. It is never suppressed.",
        },
        {
          label: "Cellexia only",
          value: "app",
          helpText:
            "Only the app sends it; the Klaviyo delivery event is not fired.",
        },
      ];
    }
    if (data.confirmationEvent) {
      return [
        {
          label: "Your Klaviyo flow (default)",
          value: "auto",
          helpText:
            "The app fires the state-change event and your Klaviyo flow sends the email — copy and design live in Klaviyo.",
        },
        {
          label: "Cellexia sends it",
          value: "app",
          helpText:
            "The app emails this confirmation directly, exactly as previewed here. Turn off any Klaviyo flow email on the same event first — otherwise the customer gets both.",
        },
      ];
    }
    return [
      {
        label: data.klaviyoConfigured
          ? "Auto — Klaviyo flow (recommended)"
          : "Auto — Cellexia sends it (Klaviyo not connected)",
        value: "auto",
        helpText:
          "Klaviyo delivers when it is connected (your flow renders {{ event.content_html }}); otherwise the app sends this exact email directly.",
      },
      {
        label: "Cellexia sends it",
        value: "app",
        helpText:
          "Always sent by the app via your email transport, exactly as previewed. The Klaviyo delivery event is not fired for this email, so a flow on the same metric will not double-send.",
      },
      {
        label: "Klaviyo flow only",
        value: "klaviyo",
        helpText:
          "Only the Klaviyo event is fired. If Klaviyo is not connected, the email is suppressed (never silently rerouted).",
      },
    ];
  }, [data.critical, data.confirmationEvent, data.klaviyoConfigured]);

  const previewWidth = device === "mobile" ? 375 : 600;

  return (
    <Page
      title={data.title}
      backAction={{ content: "Emails", url: "/app/emails" }}
      titleMetadata={
        <InlineStack gap="100">
          <Badge>{data.channel === "SMS" ? "SMS" : "Email"}</Badge>
          {data.critical && <Badge tone="attention">Always on</Badge>}
          {data.dormant && <Badge>Not active yet</Badge>}
        </InlineStack>
      }
      primaryAction={{
        content: "Save",
        onAction: save,
        loading: saving,
        disabled: !dirty || data.dormant,
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: EDITOR_CSS }} />
      <BlockStack gap="400">
        <Text as="p" variant="bodySm" tone="subdued">
          {data.trigger} · {data.sentBy} · sent {data.sentCount} times
        </Text>
        <InlineGrid columns={{ xs: 1, lg: 2 }} gap="400" alignItems="start">
          {/* ── Left: editor ─────────────────────────────────────────── */}
          <BlockStack gap="400">
            {data.senderConfigurable && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">
                    Who sends this email
                  </Text>
                  <ChoiceList
                    title="Sender"
                    titleHidden
                    choices={senderChoices}
                    selected={[sender]}
                    onChange={(values) => setSender(values[0] as SenderValue)}
                  />
                  {sender === "klaviyo" && !data.klaviyoConfigured && !data.critical && (
                    <Banner tone="warning">
                      <p>
                        Klaviyo is not connected — with this setting the email
                        will be suppressed until you add a key under
                        Settings → Klaviyo.
                      </p>
                    </Banner>
                  )}
                  {sender === "app" && data.klaviyoConfigured && (
                    <Banner tone="info">
                      <p>
                        If a Klaviyo flow currently emails this moment, switch
                        that flow email off — Cellexia now sends it, and the
                        customer should not receive both.
                      </p>
                    </Banner>
                  )}
                </BlockStack>
              </Card>
            )}

            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  Delivery
                </Text>
                {data.disableable ? (
                  <Checkbox
                    label="Send this email"
                    checked={enabled}
                    onChange={setEnabled}
                    helpText="Off = suppressed entirely (logged, never delivered)."
                  />
                ) : (
                  <Text as="p" variant="bodySm" tone="subdued">
                    This message cannot be disabled
                    {data.critical ? " (critical delivery)" : ""}.
                  </Text>
                )}
                {data.timing && (
                  <TextField
                    autoComplete="off"
                    label={`${data.timing.label}${
                      data.timing.suffix ? ` (${data.timing.suffix})` : ""
                    }`}
                    value={timing}
                    onChange={setTiming}
                    error={
                      actionData?.intent === "save"
                        ? actionData?.errors?.timing
                        : undefined
                    }
                    helpText={
                      data.timing.kind === "intList"
                        ? "Comma-separated day offsets, e.g. 0, 3, 7 — shared by the whole notice ladder."
                        : undefined
                    }
                  />
                )}
              </BlockStack>
            </Card>

            {data.customizable ? (
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">
                    Content
                  </Text>
                  <TextField
                    autoComplete="off"
                    label="Subject"
                    value={subject}
                    onChange={setSubject}
                    placeholder="Leave empty to keep the built-in subject"
                    error={
                      actionData?.intent === "save"
                        ? actionData?.errors?.subject
                        : undefined
                    }
                  />
                  <BlockStack gap="150">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="span" variant="bodyMd">
                        Body
                      </Text>
                      <ButtonGroup variant="segmented">
                        <Button size="micro" onClick={() => applyFormat("bold")}>
                          B
                        </Button>
                        <Button size="micro" onClick={() => applyFormat("italic")}>
                          I
                        </Button>
                        <Button size="micro" onClick={() => applyFormat("heading")}>
                          H
                        </Button>
                        <Button size="micro" onClick={() => applyFormat("link")}>
                          Link
                        </Button>
                        <Button size="micro" onClick={() => applyFormat("button")}>
                          Button
                        </Button>
                        <Button size="micro" onClick={() => applyFormat("list")}>
                          List
                        </Button>
                        <Button size="micro" onClick={() => applyFormat("divider")}>
                          ―
                        </Button>
                      </ButtonGroup>
                    </InlineStack>
                    <textarea
                      ref={bodyRef}
                      className="cxadm-body-editor"
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      placeholder="Leave empty to keep the built-in body"
                      spellCheck
                    />
                    {actionData?.intent === "save" && actionData?.errors?.body && (
                      <Text as="p" tone="critical" variant="bodySm">
                        {actionData.errors.body}
                      </Text>
                    )}
                    <Button
                      variant="plain"
                      size="slim"
                      disclosure={showHelp ? "up" : "down"}
                      onClick={() => setShowHelp((v) => !v)}
                    >
                      Formatting guide
                    </Button>
                    <Collapsible id="format-help" open={showHelp}>
                      <Box background="bg-surface-secondary" borderRadius="200" padding="300">
                        <BlockStack gap="100">
                          <Text as="p" variant="bodySm">
                            <code>**bold**</code> · <code>*italic*</code> ·{" "}
                            <code>[link text](https://…)</code> ·{" "}
                            <code>[button:Label]({"{portal_url}"})</code> ·{" "}
                            <code>## Heading</code> · <code>- list item</code> ·{" "}
                            <code>&gt; quote</code> · <code>---</code> divider.
                            Blank line = new paragraph. Bare links become
                            clickable automatically.
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {"{placeholders}"} are filled in per send — unknown
                            ones stay visible so typos are caught in the
                            preview.
                          </Text>
                        </BlockStack>
                      </Box>
                    </Collapsible>
                  </BlockStack>
                  <BlockStack gap="150">
                    <Text as="p" variant="bodySm" fontWeight="medium">
                      Placeholders — click to insert
                    </Text>
                    <InlineStack gap="150" wrap>
                      {placeholders.map((p) => (
                        <button
                          key={p}
                          type="button"
                          className="cxadm-chip"
                          onClick={() => insertPlaceholder(p)}
                          title={data.sampleVars[p] ?? ""}
                        >
                          {`{${p}}`}
                        </button>
                      ))}
                    </InlineStack>
                    {data.links.includes("addon_url") && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        {"{addon_url}"} adds the suggested product to the next
                        order in one click; {"{delay_1w_url}"} /{" "}
                        {"{delay_3w_url}"} push the charge back in one click —
                        proven churn reducers versus a plain manage link.
                      </Text>
                    )}
                  </BlockStack>
                </BlockStack>
              </Card>
            ) : (
              <Card>
                <Text as="p" variant="bodySm" tone="subdued">
                  Content for this message is built in
                  {data.channel === "SMS"
                    ? " (SMS copy lives in your Klaviyo flow)"
                    : ""}
                  .
                </Text>
              </Card>
            )}
          </BlockStack>

          {/* ── Right: live preview ──────────────────────────────────── */}
          <div style={{ position: "sticky", top: "16px" }}>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h3" variant="headingMd">
                    Live preview
                  </Text>
                  <InlineStack gap="200">
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
                    <Select
                      label="Preview language"
                      labelHidden
                      options={data.locales.map((l) => ({ label: l, value: l }))}
                      value={locale}
                      onChange={setLocale}
                    />
                  </InlineStack>
                </InlineStack>
                <Box background="bg-surface-secondary" borderRadius="200" padding="300">
                  <Text as="p" variant="bodySm">
                    <Text as="span" fontWeight="semibold">
                      Subject:
                    </Text>{" "}
                    {preview.subject}
                  </Text>
                </Box>
                <Box borderWidth="025" borderColor="border" borderRadius="200">
                  <div
                    style={{
                      maxWidth: previewWidth,
                      margin: "0 auto",
                      transition: "max-width .2s ease",
                    }}
                  >
                    <iframe
                      className="cxadm-preview-frame"
                      title="Email preview"
                      sandbox=""
                      srcDoc={preview.html}
                    />
                  </div>
                </Box>
                <Text as="p" variant="bodySm" tone="subdued">
                  Rendered with sample data — the same pipeline every real send
                  uses. Merchant copy previews in your written language; the
                  built-in copy follows the customer&rsquo;s language.
                </Text>
                <Button
                  variant="plain"
                  size="slim"
                  disclosure={showText ? "up" : "down"}
                  onClick={() => setShowText((v) => !v)}
                >
                  Plain-text version
                </Button>
                <Collapsible id="text-preview" open={showText}>
                  <Box background="bg-surface-secondary" borderRadius="200" padding="300">
                    <pre
                      style={{
                        margin: 0,
                        whiteSpace: "pre-wrap",
                        font: "12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
                      }}
                    >
                      {preview.text}
                    </pre>
                  </Box>
                </Collapsible>
                {data.channel === "EMAIL" && (
                  <>
                    <Divider />
                    <InlineStack gap="200" blockAlign="end" wrap={false}>
                      <Box width="100%">
                        <TextField
                          autoComplete="email"
                          label="Send a test to"
                          value={testTo}
                          onChange={setTestTo}
                          error={
                            actionData?.intent === "send-test"
                              ? actionData?.errors?.to
                              : undefined
                          }
                        />
                      </Box>
                      <Button onClick={sendTest} loading={testing}>
                        Send test
                      </Button>
                    </InlineStack>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Tests use your email transport (Settings → Email
                      delivery); every link points at example.com, so nothing
                      in a test email can touch a real subscription.
                    </Text>
                  </>
                )}
              </BlockStack>
            </Card>
          </div>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
