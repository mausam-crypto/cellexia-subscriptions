import { useEffect, useRef, useState } from "react";
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
  Card,
  Collapsible,
  Divider,
  InlineStack,
  IndexTable,
  Layout,
  Link as PolarisLink,
  Page,
  ProgressBar,
  Spinner,
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
  readCachedCoverage,
  type CoverageRow,
} from "~/lib/klaviyo/flows.server";
import {
  cachedCoverageRows,
  getFlowTask,
  startFlowTask,
  type FlowTaskState,
} from "~/lib/klaviyo/setup-task.server";
import type { loader as statusLoader } from "~/routes/app.emails_.setup_.status";
import { EMAIL_CATALOG } from "~/lib/notifications/catalog.server";

/**
 * Guided Klaviyo delivery setup (v1.18.0; made instant + background in
 * v1.25.0) — three steps, zero jargon:
 *
 *  1. Connect a Klaviyo key that is allowed to manage flows (click-by-click
 *     instructions; paste box right here — no detour through Settings).
 *  2. One button creates every flow in Klaviyo: metric trigger, the
 *     cellexia_send safety filter, and an email that renders exactly what
 *     the app wrote. Idempotent — click it until everything is green.
 *  3. A live checklist: every subscription email with a green check when a
 *     LIVE flow delivers it (the merchant's own hand-built flows count).
 *
 * The loader makes ZERO Klaviyo calls: it renders the cached checklist and
 * the current background task, and (when the cache is stale) starts a
 * verify task without waiting for it. "Create my flows" / "Check again"
 * start background tasks (setup-task.server.ts) and return immediately;
 * the page polls /app/emails/setup/status every 1.5 s while one runs, so
 * the merchant sees "Creating flow 4 of 12 — …" instead of a hung request.
 * The file name is escaped (`app.emails_.setup`) so the Emails overview's
 * heavy loader no longer runs on every visit and action here.
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

/** Cache older than this triggers a background re-verification on visit. */
const AUTO_VERIFY_STALE_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 1_500;
const STATUS_URL = "/app/emails/setup/status";

/**
 * run-setup/refresh only START a background task — the rows arrive via the
 * status poll, so re-running the loader would be wasted DB work. save-key
 * keeps the default so data.configured/keySource refresh.
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
  const actor = actorFromSession(session);
  const [configured, auth, cached, currentTask] = await Promise.all([
    isKlaviyoConfigured(shop.id).catch(() => false),
    resolveKlaviyoAuth(shop.id).catch(() => ({ apiKey: null, source: null })),
    readCachedCoverage(shop.id),
    getFlowTask(shop.id),
  ]);
  const rows = await cachedCoverageRows(shop.id, cached);

  // Stale (or absent) cache + a connected key + nothing running → kick off
  // a verification in the background and render the last-known rows now.
  // The most recent TOUCH (failed attempts included) throttles this so a
  // broken key does not re-probe Klaviyo on every visit.
  let task: FlowTaskState | null = currentTask;
  if (configured && task?.state !== "running") {
    const lastTouch = [cached.checkedAt, cached.lastAttemptAt]
      .filter((v): v is string => typeof v === "string")
      .sort()
      .pop();
    const ageMs = lastTouch
      ? Date.now() - new Date(lastTouch).getTime()
      : Number.POSITIVE_INFINITY;
    if (ageMs > AUTO_VERIFY_STALE_MS) {
      try {
        task = (await startFlowTask(shop.id, "verify", { actor })).task;
      } catch (err) {
        console.error("[emails-setup] could not start verification", err);
      }
    }
  }

  return json({
    configured,
    keySource: auth.source,
    cached: { checkedAt: cached.checkedAt, setupRanAt: cached.setupRanAt, rows },
    task,
    excluded: EXCLUDED_FROM_SETUP.map((e) => ({
      title: EMAIL_CATALOG[e.template].title,
      reason: e.reason,
    })),
    actorEmail: actor,
  });
};

interface ActionData {
  intent: string;
  ok: boolean;
  toast?: string;
  /** For run-setup / refresh: whether a NEW task was started. */
  started?: boolean;
  task?: FlowTaskState;
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
    // The new key may unlock reads the old one could not — verify now (in
    // the background; the loader revalidation picks the running task up).
    // While another task is still running it keeps using the OLD key (auth
    // is resolved once at its start), so `started:false` tells the page
    // that a re-verify is still owed: it submits `refresh` once that run
    // finishes (see the pendingVerifyRef effect) — otherwise the old run's
    // fatal ("key cannot read metrics") would contradict the "saved" toast.
    let started = false;
    let task: FlowTaskState | undefined;
    try {
      const result = await startFlowTask(shop.id, "verify", { actor });
      started = result.started;
      task = result.task;
    } catch (err) {
      console.error("[emails-setup] could not start verification", err);
    }
    return json<ActionData>({
      intent,
      ok: true,
      started,
      task,
      toast:
        !started && task?.state === "running"
          ? "Klaviyo key saved — the checklist re-checks with the new key as soon as the current run finishes"
          : "Klaviyo key saved — it applies within a minute",
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
    const result = await startFlowTask(shop.id, "setup", { seedEmail, actor });
    return json<ActionData>({
      intent,
      ok: true,
      started: result.started,
      task: result.task,
      toast: result.started
        ? "Creating your flows — this runs in the background, you can watch the progress below"
        : result.task.kind === "setup"
          ? "Flow setup is already running (maybe in another tab) — following its progress"
          : "A checklist verification is still running — try again when it finishes",
    });
  }

  if (intent === "refresh") {
    const result = await startFlowTask(shop.id, "verify", { actor });
    return json<ActionData>({
      intent,
      ok: true,
      started: result.started,
      task: result.task,
      toast: result.started
        ? undefined
        : "Something is already running (maybe in another tab) — following its progress",
    });
  }

  return json<ActionData>({ intent, ok: false, toast: "Unknown action" }, { status: 400 });
};

// ── UI ───────────────────────────────────────────────────────────────────────

type SerializedRow = SerializeFrom<CoverageRow>;
type SerializedTask = SerializeFrom<FlowTaskState>;
type StatusData = SerializeFrom<typeof statusLoader>;

const STATUS_META: Record<
  string,
  { label: string; tone?: "success" | "warning" | "critical" | "attention" }
> = {
  live: { label: "Live", tone: "success" },
  not_live: { label: "Needs one click", tone: "warning" },
  missing: { label: "Not set up", tone: "critical" },
  pending_metric: { label: "Waiting for Klaviyo", tone: "attention" },
  rate_limited: { label: "Klaviyo is busy — continues on next run", tone: "attention" },
  app_delivers: { label: "Cellexia delivers it", tone: "success" },
  off: { label: "Turned off in the app" },
  error: { label: "Problem", tone: "critical" },
  unchecked: { label: "Not checked yet" },
};

/** Rows that count toward the "X of Y live" flow tally. */
const NEEDS_FLOW = (status: string): boolean =>
  status !== "app_delivers" && status !== "off";

function completionToast(task: SerializedTask): { text: string; isError: boolean } {
  if (task.state === "failed") {
    return {
      text: task.error ?? "The last run stopped unexpectedly — start it again.",
      isError: true,
    };
  }
  const report = task.report;
  if (!report) return { text: "Done.", isError: false };
  if (report.fatal) return { text: report.fatal, isError: true };
  const flowRows = report.rows.filter((r) => NEEDS_FLOW(r.status));
  const live = flowRows.filter((r) => r.status === "live").length;
  return {
    text:
      task.kind === "setup"
        ? `${live} of ${flowRows.length} emails are now delivered by a live Klaviyo flow`
        : `Checklist refreshed — ${live} of ${flowRows.length} live`,
    isError: false,
  };
}

export default function KlaviyoSetupPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const navigation = useNavigation();
  const statusFetcher = useFetcher<StatusData>();

  const [key, setKey] = useState("");
  const [showKeyHelp, setShowKeyHelp] = useState(!data.configured);
  const [task, setTask] = useState<SerializedTask | null>(data.task);
  const [cached, setCached] = useState(data.cached);

  const navIntent = navigation.formData?.get("intent");
  const savingKey = navigation.state === "submitting" && navIntent === "save-key";
  const startingSetup = navigation.state === "submitting" && navIntent === "run-setup";
  const startingRefresh = navigation.state === "submitting" && navIntent === "refresh";

  // Loader data changes only on a full load / save-key revalidation —
  // re-sync the live copies then.
  useEffect(() => {
    setTask(data.task);
    setCached(data.cached);
  }, [data]);

  // A key saved while a verify/setup was still running is NOT verified by
  // that run (it resolved auth at its start) — remember which task must
  // finish first, then submit one `refresh` for the new key.
  const pendingVerifyRef = useRef<string | null>(null);
  useEffect(() => {
    if (actionData?.toast) {
      shopify.toast.show(actionData.toast, { isError: !actionData.ok });
    }
    if (actionData?.intent === "save-key" && actionData.ok) {
      setKey("");
      if (actionData.started === false && actionData.task?.state === "running") {
        pendingVerifyRef.current = actionData.task.id;
      }
    }
    // Start following the task straight away (no loader revalidation for
    // run-setup/refresh — the task record rides the action response).
    if (actionData?.task) setTask(actionData.task);
  }, [actionData, shopify]);

  useEffect(() => {
    const owed = pendingVerifyRef.current;
    if (!owed || !task || task.id !== owed || task.state === "running") return;
    pendingVerifyRef.current = null;
    const form = new FormData();
    form.set("intent", "refresh");
    submit(form, { method: "post" });
  }, [task, submit]);

  // ── Poll the status route while a task runs ─────────────────────────────
  const running = task?.state === "running";
  // The fetcher is read through a ref at tick time: a slow response must
  // not stack requests, and re-subscribing the interval on every fetcher
  // state flip would reset it and starve the poll under a slow network.
  const fetcherRef = useRef(statusFetcher);
  fetcherRef.current = statusFetcher;
  useEffect(() => {
    if (!running) return;
    const tick = (): void => {
      const fetcher = fetcherRef.current;
      if (fetcher.state === "idle") fetcher.load(STATUS_URL);
    };
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [running]);

  const lastSeenRef = useRef<{ id: string; state: string } | null>(
    data.task ? { id: data.task.id, state: data.task.state } : null,
  );
  useEffect(() => {
    const status = statusFetcher.data;
    if (!status) return;
    setCached(status.cached);
    const next = status.task;
    if (!next) return;
    setTask((prev) => {
      // Never let a stale poll (older updatedAt) roll a fresher local copy back.
      if (prev && prev.id === next.id && prev.updatedAt > next.updatedAt) return prev;
      return next;
    });
    const seen = lastSeenRef.current;
    const finished = next.state === "done" || next.state === "failed";
    if (finished && (!seen || seen.id !== next.id || seen.state === "running")) {
      const toast = completionToast(next);
      shopify.toast.show(toast.text, { isError: toast.isError });
    }
    lastSeenRef.current = { id: next.id, state: next.state };
  }, [statusFetcher.data, shopify]);

  // Rows: always the cached checklist (one row per spec, "unchecked" until
  // verified) — every run persists its rows BEFORE it is marked done and
  // the poll returns both together, so the cache is never behind a task's
  // report, while a task's report can be behind the cache (the daily alert
  // sweep re-verifies without a task). Never an empty table.
  const report = task?.state === "done" ? task.report : null;
  const rows = cached.rows as SerializedRow[];
  const flowRows = rows.filter((r) => NEEDS_FLOW(r.status));
  const liveCount = flowRows.filter((r) => r.status === "live").length;
  const checkedCount = rows.filter((r) => r.status !== "unchecked").length;
  const allLive =
    flowRows.length > 0 &&
    checkedCount === rows.length &&
    liveCount === flowRows.length;
  const pendingCount = flowRows.filter(
    (r) => r.status === "pending_metric" || r.status === "rate_limited",
  ).length;
  const checkedAt = cached.checkedAt;

  const verifying = running && task?.kind === "verify";
  const settingUp = running && task?.kind === "setup";
  const anyBusy = running || startingSetup || startingRefresh;
  // A fatal from the last run stays relevant until a LATER successful check.
  const fatal =
    report?.fatal &&
    (!cached.checkedAt || !task?.finishedAt || task.finishedAt > cached.checkedAt)
      ? report.fatal
      : undefined;
  const taskError = task?.state === "failed" ? task.error : null;
  const progressPct =
    task && task.total > 0 ? Math.round((task.done / task.total) * 100) : 0;

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
            {allLive && !running && (
              <Banner tone="success" title="You're done — Klaviyo delivers everything">
                <p>
                  All {flowRows.length} Klaviyo-delivered subscription emails
                  have a live flow. Copy, design and timing stay controlled
                  from the Emails pages — you never need to edit these flows.
                </p>
              </Banner>
            )}
            {fatal && (
              <Banner tone="warning" title="One thing to fix first">
                <p>{fatal}</p>
              </Banner>
            )}
            {taskError && (
              <Banner tone="critical" title="The last run did not finish">
                <p>{taskError}</p>
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
                  untouched — nothing is ever duplicated. It runs in the
                  background at the pace Klaviyo allows (a few minutes for a
                  full set) — you can leave this page and come back. Safe to
                  click as many times as it takes.
                </Text>
                <InlineStack gap="200" blockAlign="center">
                  <Button
                    variant="primary"
                    onClick={() => post("run-setup")}
                    loading={settingUp || startingSetup}
                    disabled={!data.configured || anyBusy}
                  >
                    Create my flows
                  </Button>
                  {!data.configured && (
                    <Text as="span" variant="bodySm" tone="subdued">
                      Connect a key in step 1 first.
                    </Text>
                  )}
                  {verifying && (
                    <Text as="span" variant="bodySm" tone="subdued">
                      Checking your flows first…
                    </Text>
                  )}
                </InlineStack>
                {settingUp && task && (
                  <Box
                    background="bg-surface-secondary"
                    borderRadius="200"
                    padding="300"
                  >
                    <BlockStack gap="200">
                      <ProgressBar
                        progress={progressPct}
                        size="small"
                        tone="primary"
                        animated
                      />
                      <InlineStack gap="200" blockAlign="center">
                        <Spinner size="small" accessibilityLabel="Setup running" />
                        <Text as="span" variant="bodySm">
                          {task.message || "Working…"}
                        </Text>
                      </InlineStack>
                    </BlockStack>
                  </Box>
                )}
                {(report?.seeded?.length ?? 0) > 0 && (
                  <Banner tone="info">
                    <p>
                      {report?.seeded.length} of your subscription moments were
                      brand new to Klaviyo, so the app just introduced them
                      (no emails were sent doing this). Klaviyo usually
                      registers them within the run — if some rows below still
                      say &ldquo;Waiting for Klaviyo&rdquo;, click{" "}
                      <b>Create my flows</b> once more.
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
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="h2" variant="headingMd">
                        Step 3 — Your delivery checklist
                      </Text>
                      {verifying && (
                        <Badge tone="info" progress="partiallyComplete">
                          Checking…
                        </Badge>
                      )}
                    </InlineStack>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {!data.configured
                        ? "Connect a key to check the checklist."
                        : checkedCount === 0
                          ? verifying
                            ? "Checking your Klaviyo flows for the first time…"
                            : "Not checked yet — click “Check again”."
                          : `${liveCount} of ${flowRows.length} live${
                              pendingCount > 0 ? ` · ${pendingCount} waiting` : ""
                            } · checked ${checkedAt ? formatUtcLabel(checkedAt) : "—"}`}
                    </Text>
                  </BlockStack>
                  <Button
                    size="slim"
                    onClick={() => post("refresh")}
                    loading={verifying || startingRefresh}
                    disabled={!data.configured || anyBusy}
                  >
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
