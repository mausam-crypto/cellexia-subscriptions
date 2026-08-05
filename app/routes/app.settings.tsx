/**
 * Settings admin — Integrations (Klaviyo + outbox health), Team & roles (RBAC),
 * Audit log viewer (hash-chain verification), Data (reconciliation, exports,
 * GDPR) and General (currency + settingsJson guardrails).
 *
 * Access: OWNER / ADMIN only (services/core/rbac.server requireRole).
 * Every state change appends an audit entry.
 */
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
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
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  DataTable,
  Divider,
  FormLayout,
  InlineStack,
  Layout,
  Page,
  Pagination,
  Select,
  Tabs,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { encryptSecret } from "~/lib/crypto.server";
import { appendAudit, verifyAuditChain } from "~/services/audit.server";
import { requireRole } from "~/services/core/rbac.server";
import { runReconcileJob } from "~/services/core/reconcile.server";
import { SUGGESTED_FLOWS } from "~/services/communications/templates.server";
import {
  ACTOR_TYPES,
  OUTBOX_STATUSES,
  STAFF_ROLE_NAMES,
  parseJson,
  type OutboxStatus,
} from "~/types/domain";

const AUDIT_PAGE_SIZE = 25;

const STATUS_PENDING: OutboxStatus = "PENDING";
const STATUS_DEAD: OutboxStatus = "DEAD";

// ─────────────────────────────── Loader ────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireRole(session, "OWNER", "ADMIN");
  const shop = session.shop;

  const url = new URL(request.url);
  const auditPage = Math.max(
    1,
    Number.parseInt(url.searchParams.get("auditPage") ?? "1", 10) || 1,
  );
  const actorType = url.searchParams.get("actorType") ?? "";
  const actionFilter = url.searchParams.get("actionFilter") ?? "";
  const subjectFilter = url.searchParams.get("subjectFilter") ?? "";

  const [settings, outboxGroups, staff] = await Promise.all([
    prisma.shopSettings.findUnique({ where: { shop } }),
    prisma.outboundEvent.groupBy({
      by: ["status"],
      where: { shop },
      _count: { _all: true },
    }),
    prisma.staffRole.findMany({ where: { shop }, orderBy: { createdAt: "asc" } }),
  ]);

  const auditWhere = {
    shop,
    ...(actorType ? { actorType } : {}),
    ...(actionFilter ? { action: { contains: actionFilter } } : {}),
    ...(subjectFilter
      ? {
          OR: [
            { subjectId: { contains: subjectFilter } },
            { subjectType: { contains: subjectFilter } },
          ],
        }
      : {}),
  };
  const [auditTotal, auditRows] = await Promise.all([
    prisma.auditLog.count({ where: auditWhere }),
    prisma.auditLog.findMany({
      where: auditWhere,
      orderBy: { seq: "desc" },
      skip: (auditPage - 1) * AUDIT_PAGE_SIZE,
      take: AUDIT_PAGE_SIZE,
    }),
  ]);

  const outbox = Object.fromEntries(
    OUTBOX_STATUSES.map((status) => [status, 0]),
  ) as Record<OutboxStatus, number>;
  for (const group of outboxGroups) {
    if ((OUTBOX_STATUSES as readonly string[]).includes(group.status)) {
      outbox[group.status as OutboxStatus] = group._count._all;
    }
  }

  const general = parseJson<Record<string, unknown>>(
    settings?.settingsJson ?? "{}",
    {},
  );
  const asInt = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(value)
      : fallback;

  // Customer policy: settingsJson.minPauseCancelWindow (shared contract) —
  // {"enabled": false, "days": 10}, OFF by default.
  const rawWindow = general.minPauseCancelWindow;
  const windowObj =
    typeof rawWindow === "object" && rawWindow !== null && !Array.isArray(rawWindow)
      ? (rawWindow as Record<string, unknown>)
      : {};
  const minPauseCancelWindow = {
    enabled: windowObj.enabled === true,
    days: Math.min(90, Math.max(1, asInt(windowObj.days, 10))),
  };

  return json({
    klaviyo: {
      enabled: settings?.klaviyoEnabled ?? false,
      keySet: Boolean(settings?.klaviyoApiKeyEncrypted),
    },
    outbox,
    flows: SUGGESTED_FLOWS,
    staff: staff.map((entry) => ({
      id: entry.id,
      email: entry.email,
      role: entry.role,
      createdAt: entry.createdAt.toISOString(),
    })),
    audit: {
      rows: auditRows.map((row) => ({
        id: row.id,
        seq: row.seq,
        actorType: row.actorType,
        actorId: row.actorId,
        action: row.action,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        payloadJson: row.payloadJson,
        createdAt: row.createdAt.toISOString(),
      })),
      total: auditTotal,
      page: auditPage,
      pageSize: AUDIT_PAGE_SIZE,
      filters: { actorType, actionFilter, subjectFilter },
    },
    general: {
      currencyCode: settings?.currencyCode ?? "EUR",
      giftThresholdCents: asInt(general.giftThresholdCents, 15000),
      preDunningLeadDays: asInt(general.preDunningLeadDays, 10),
      highValueGraceDays: asInt(general.highValueGraceDays, 7),
      minPauseCancelWindow,
    },
  });
};

// ─────────────────────────────── Action ────────────────────────────────────

interface ActionResult {
  ok: boolean;
  message?: string;
  verify?: { ok: boolean; brokenAtSeq?: number };
  reconcile?: unknown;
}

function readNonNegativeInt(value: FormDataEntryValue | null): number | null {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireRole(session, "OWNER", "ADMIN");
  const shop = session.shop;
  const actorId =
    session.onlineAccessInfo?.associated_user?.email ?? shop;

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  switch (intent) {
    case "save-klaviyo": {
      const apiKey = String(formData.get("apiKey") ?? "").trim();
      const enabled = String(formData.get("enabled")) === "true";
      const existing = await prisma.shopSettings.findUnique({ where: { shop } });
      if (enabled && !apiKey && !existing?.klaviyoApiKeyEncrypted) {
        return json<ActionResult>(
          {
            ok: false,
            message:
              "Add a Klaviyo private API key before enabling the integration.",
          },
          { status: 400 },
        );
      }
      const keyUpdate = apiKey
        ? { klaviyoApiKeyEncrypted: encryptSecret(apiKey) }
        : {};
      await prisma.shopSettings.upsert({
        where: { shop },
        update: { klaviyoEnabled: enabled, ...keyUpdate },
        create: { shop, klaviyoEnabled: enabled, ...keyUpdate },
      });
      await appendAudit({
        shop,
        actorType: "STAFF",
        actorId,
        action: "settings.klaviyo_updated",
        subjectType: "ShopSettings",
        subjectId: shop,
        payload: { enabled, keyRotated: Boolean(apiKey) },
      });
      return json<ActionResult>({ ok: true, message: "Klaviyo settings saved." });
    }

    case "retry-dead": {
      const result = await prisma.outboundEvent.updateMany({
        where: { shop, status: STATUS_DEAD },
        data: {
          status: STATUS_PENDING,
          attempts: 0,
          nextAttemptAt: new Date(),
          lastError: null,
        },
      });
      await appendAudit({
        shop,
        actorType: "STAFF",
        actorId,
        action: "outbox.dead_retried",
        payload: { count: result.count },
      });
      return json<ActionResult>({
        ok: true,
        message: `${result.count} dead event${result.count === 1 ? "" : "s"} requeued for delivery.`,
      });
    }

    case "add-role": {
      const email = String(formData.get("email") ?? "")
        .trim()
        .toLowerCase();
      const role = String(formData.get("role") ?? "");
      if (!email || !email.includes("@")) {
        return json<ActionResult>(
          { ok: false, message: "Enter a valid email address." },
          { status: 400 },
        );
      }
      if (!(STAFF_ROLE_NAMES as readonly string[]).includes(role)) {
        return json<ActionResult>(
          { ok: false, message: "Choose a valid role." },
          { status: 400 },
        );
      }
      await prisma.staffRole.upsert({
        where: { shop_email: { shop, email } },
        update: { role },
        create: { shop, email, role },
      });
      await appendAudit({
        shop,
        actorType: "STAFF",
        actorId,
        action: "staff.role_assigned",
        subjectType: "StaffRole",
        subjectId: email,
        payload: { role },
      });
      return json<ActionResult>({ ok: true, message: `${email} is now ${role}.` });
    }

    case "remove-role": {
      const id = String(formData.get("id") ?? "");
      const existing = await prisma.staffRole.findFirst({ where: { id, shop } });
      if (!existing) {
        return json<ActionResult>(
          { ok: false, message: "Role entry not found." },
          { status: 404 },
        );
      }
      await prisma.staffRole.delete({ where: { id: existing.id } });
      await appendAudit({
        shop,
        actorType: "STAFF",
        actorId,
        action: "staff.role_removed",
        subjectType: "StaffRole",
        subjectId: existing.email,
        payload: { role: existing.role },
      });
      return json<ActionResult>({
        ok: true,
        message: `${existing.email} removed.`,
      });
    }

    case "verify-chain": {
      const verify = await verifyAuditChain(shop);
      return json<ActionResult>({ ok: true, verify });
    }

    case "run-reconcile": {
      await appendAudit({
        shop,
        actorType: "STAFF",
        actorId,
        action: "reconcile.triggered",
      });
      const reconcile: unknown = await runReconcileJob(shop);
      return json<ActionResult>({
        ok: true,
        message: "Reconciliation completed.",
        reconcile: reconcile ?? null,
      });
    }

    case "save-general": {
      const currencyCode = String(formData.get("currencyCode") ?? "")
        .trim()
        .toUpperCase();
      if (!/^[A-Z]{3}$/.test(currencyCode)) {
        return json<ActionResult>(
          {
            ok: false,
            message: "Currency must be a 3-letter ISO code (e.g. EUR).",
          },
          { status: 400 },
        );
      }
      const giftThresholdCents = readNonNegativeInt(
        formData.get("giftThresholdCents"),
      );
      const preDunningLeadDays = readNonNegativeInt(
        formData.get("preDunningLeadDays"),
      );
      const highValueGraceDays = readNonNegativeInt(
        formData.get("highValueGraceDays"),
      );
      if (
        giftThresholdCents === null ||
        preDunningLeadDays === null ||
        highValueGraceDays === null
      ) {
        return json<ActionResult>(
          {
            ok: false,
            message: "All values must be whole numbers of 0 or more.",
          },
          { status: 400 },
        );
      }
      // Customer policy: minimum pause/cancel window (shared contract shape
      // settingsJson.minPauseCancelWindow = {enabled, days}).
      const minWindowEnabled =
        String(formData.get("minWindowEnabled")) === "true";
      const minWindowDays = Number.parseInt(
        String(formData.get("minWindowDays") ?? ""),
        10,
      );
      if (
        !Number.isInteger(minWindowDays) ||
        minWindowDays < 1 ||
        minWindowDays > 90
      ) {
        return json<ActionResult>(
          {
            ok: false,
            message:
              "The pause/cancel window must be a whole number of days between 1 and 90.",
          },
          { status: 400 },
        );
      }
      const existing = await prisma.shopSettings.findUnique({ where: { shop } });
      // Merge over existing settingsJson so keys owned by other modules survive.
      const merged = {
        ...parseJson<Record<string, unknown>>(existing?.settingsJson ?? "{}", {}),
        giftThresholdCents,
        preDunningLeadDays,
        highValueGraceDays,
        minPauseCancelWindow: {
          enabled: minWindowEnabled,
          days: minWindowDays,
        },
      };
      const settingsJson = JSON.stringify(merged);
      await prisma.shopSettings.upsert({
        where: { shop },
        update: { currencyCode, settingsJson },
        create: { shop, currencyCode, settingsJson },
      });
      await appendAudit({
        shop,
        actorType: "STAFF",
        actorId,
        action: "settings.general_updated",
        subjectType: "ShopSettings",
        subjectId: shop,
        payload: {
          currencyCode,
          giftThresholdCents,
          preDunningLeadDays,
          highValueGraceDays,
          minPauseCancelWindow: {
            enabled: minWindowEnabled,
            days: minWindowDays,
          },
        },
      });
      return json<ActionResult>({ ok: true, message: "General settings saved." });
    }

    default:
      return json<ActionResult>(
        { ok: false, message: "Unknown action." },
        { status: 400 },
      );
  }
};

// ─────────────────────────────── Component ─────────────────────────────────

const TAB_IDS = ["integrations", "team", "audit", "data", "general"] as const;

const OUTBOX_TONES: Record<
  OutboxStatus,
  "info" | "success" | "warning" | "critical"
> = {
  PENDING: "info",
  SENT: "success",
  FAILED: "warning",
  DEAD: "critical",
};

export default function SettingsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();

  const busyIntent =
    navigation.state !== "idle"
      ? String(navigation.formData?.get("intent") ?? "")
      : "";

  const tabParam = searchParams.get("tab") ?? "integrations";
  const selectedTab = Math.max(
    0,
    (TAB_IDS as readonly string[]).indexOf(tabParam),
  );
  const handleTabChange = (index: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", TAB_IDS[index] ?? "integrations");
    setSearchParams(next, { replace: true });
  };

  // Integrations
  const [apiKey, setApiKey] = useState("");
  const [klaviyoOn, setKlaviyoOn] = useState(data.klaviyo.enabled);

  // Team
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<string>("CS_AGENT");

  // Audit filters
  const [actorFilter, setActorFilter] = useState(data.audit.filters.actorType);
  const [actionFilter, setActionFilter] = useState(
    data.audit.filters.actionFilter,
  );
  const [subjectFilter, setSubjectFilter] = useState(
    data.audit.filters.subjectFilter,
  );

  // General
  const [currency, setCurrency] = useState(data.general.currencyCode);
  const [gift, setGift] = useState(String(data.general.giftThresholdCents));
  const [lead, setLead] = useState(String(data.general.preDunningLeadDays));
  const [grace, setGrace] = useState(String(data.general.highValueGraceDays));
  const [minWindowOn, setMinWindowOn] = useState(
    data.general.minPauseCancelWindow.enabled,
  );
  const [minWindowDays, setMinWindowDays] = useState(
    String(data.general.minPauseCancelWindow.days),
  );

  const applyAuditFilters = () => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", "audit");
    next.set("auditPage", "1");
    if (actorFilter) next.set("actorType", actorFilter);
    else next.delete("actorType");
    if (actionFilter) next.set("actionFilter", actionFilter);
    else next.delete("actionFilter");
    if (subjectFilter) next.set("subjectFilter", subjectFilter);
    else next.delete("subjectFilter");
    setSearchParams(next);
  };

  const gotoAuditPage = (page: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", "audit");
    next.set("auditPage", String(page));
    setSearchParams(next);
  };

  const totalAuditPages = Math.max(
    1,
    Math.ceil(data.audit.total / data.audit.pageSize),
  );

  const tabs = [
    { id: "integrations", content: "Integrations" },
    { id: "team", content: "Team & roles" },
    { id: "audit", content: "Audit log" },
    { id: "data", content: "Data" },
    { id: "general", content: "General" },
  ];

  return (
    <Page>
      <TitleBar title="Settings" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData?.message ? (
              <Banner
                tone={actionData.ok ? "success" : "critical"}
                title={actionData.message}
              />
            ) : null}

            <Tabs tabs={tabs} selected={selectedTab} onSelect={handleTabChange}>
              <Box paddingBlockStart="400">
                {selectedTab === 0 ? (
                  <BlockStack gap="400">
                    <Card>
                      <BlockStack gap="400">
                        <Text as="h2" variant="headingMd">
                          Klaviyo
                        </Text>
                        <Text as="p" tone="subdued">
                          Lifecycle events (deliveries, payment issues,
                          milestones…) queue in the outbox and are delivered to
                          Klaviyo as &quot;Cellexia …&quot; metrics, ready to
                          trigger the flows below.
                        </Text>
                        <FormLayout>
                          <TextField
                            label="Private API key"
                            type="password"
                            value={apiKey}
                            onChange={setApiKey}
                            autoComplete="off"
                            placeholder={data.klaviyo.keySet ? "••••••••" : "pk_…"}
                            helpText={
                              data.klaviyo.keySet
                                ? "A key is stored (encrypted at rest). Enter a new key only to rotate it."
                                : "Create a private key with Events write access in Klaviyo → Settings → API keys. Stored encrypted at rest."
                            }
                          />
                          <Checkbox
                            label="Enable Klaviyo delivery"
                            checked={klaviyoOn}
                            onChange={setKlaviyoOn}
                            helpText="When disabled, queued events are marked dead with the error “klaviyo disabled”."
                          />
                          <Button
                            variant="primary"
                            loading={busyIntent === "save-klaviyo"}
                            onClick={() =>
                              submit(
                                {
                                  intent: "save-klaviyo",
                                  apiKey,
                                  enabled: String(klaviyoOn),
                                },
                                { method: "post" },
                              )
                            }
                          >
                            Save Klaviyo settings
                          </Button>
                        </FormLayout>
                      </BlockStack>
                    </Card>

                    <Card>
                      <BlockStack gap="400">
                        <Text as="h2" variant="headingMd">
                          Outbox health
                        </Text>
                        <InlineStack gap="400" wrap>
                          {OUTBOX_STATUSES.map((status) => (
                            <Box
                              key={status}
                              borderColor="border"
                              borderWidth="025"
                              borderRadius="200"
                              padding="300"
                              minWidth="140px"
                            >
                              <BlockStack gap="100">
                                <Badge tone={OUTBOX_TONES[status]}>{status}</Badge>
                                <Text as="p" variant="headingLg">
                                  {String(data.outbox[status])}
                                </Text>
                              </BlockStack>
                            </Box>
                          ))}
                        </InlineStack>
                        <InlineStack gap="200">
                          <Button
                            disabled={data.outbox.DEAD === 0}
                            loading={busyIntent === "retry-dead"}
                            onClick={() =>
                              submit({ intent: "retry-dead" }, { method: "post" })
                            }
                          >
                            {`Retry dead events (${data.outbox.DEAD})`}
                          </Button>
                        </InlineStack>
                        <Text as="p" tone="subdued" variant="bodySm">
                          Delivery runs via the scheduled outbox job
                          (POST /jobs/outbox). Failed events retry with
                          exponential backoff and are marked dead after 8
                          attempts.
                        </Text>
                      </BlockStack>
                    </Card>

                    <Card>
                      <BlockStack gap="400">
                        <Text as="h2" variant="headingMd">
                          Suggested Klaviyo flows
                        </Text>
                        <Text as="p" tone="subdued">
                          Build these flows in Klaviyo, each triggered by the
                          metric shown. Copy skeletons follow the Cellexia voice
                          — calm, premium, never pushy.
                        </Text>
                        {data.flows.map((flow) => (
                          <Box
                            key={flow.key}
                            borderColor="border"
                            borderWidth="025"
                            borderRadius="200"
                            padding="400"
                          >
                            <BlockStack gap="200">
                              <InlineStack gap="200" blockAlign="center" wrap>
                                <Text as="h3" variant="headingSm">
                                  {flow.title}
                                </Text>
                                <Badge>{flow.metricName}</Badge>
                              </InlineStack>
                              <Text as="p" tone="subdued" variant="bodySm">
                                Fires: {flow.whenItFires}
                              </Text>
                              <Text as="p" variant="bodySm" fontWeight="semibold">
                                Subject: {flow.copySkeleton.subject}
                              </Text>
                              {flow.copySkeleton.body.map((line, index) => (
                                <Text
                                  key={index}
                                  as="p"
                                  variant="bodySm"
                                  tone="subdued"
                                >
                                  {line}
                                </Text>
                              ))}
                            </BlockStack>
                          </Box>
                        ))}
                      </BlockStack>
                    </Card>
                  </BlockStack>
                ) : null}

                {selectedTab === 1 ? (
                  <Card>
                    <BlockStack gap="400">
                      <Text as="h2" variant="headingMd">
                        Team &amp; roles
                      </Text>
                      <Banner tone="info">
                        <Text as="p">
                          Role-based access: OWNER and ADMIN have full access,
                          including these settings. CS_AGENT can use the
                          subscriber console only. ANALYST has read-only access
                          to analytics. Staff are matched by the email of their
                          Shopify admin account.
                        </Text>
                      </Banner>
                      <FormLayout>
                        <FormLayout.Group>
                          <TextField
                            label="Staff email"
                            value={newEmail}
                            onChange={setNewEmail}
                            autoComplete="email"
                            placeholder="name@cellexia.com"
                          />
                          <Select
                            label="Role"
                            options={STAFF_ROLE_NAMES.map((role) => ({
                              label: role,
                              value: role,
                            }))}
                            value={newRole}
                            onChange={setNewRole}
                          />
                        </FormLayout.Group>
                        <Button
                          variant="primary"
                          disabled={!newEmail}
                          loading={busyIntent === "add-role"}
                          onClick={() =>
                            submit(
                              {
                                intent: "add-role",
                                email: newEmail,
                                role: newRole,
                              },
                              { method: "post" },
                            )
                          }
                        >
                          Add or update role
                        </Button>
                      </FormLayout>
                      <Divider />
                      {data.staff.length === 0 ? (
                        <Text as="p" tone="subdued">
                          No staff roles yet — the store owner has implicit
                          OWNER access.
                        </Text>
                      ) : (
                        <DataTable
                          columnContentTypes={["text", "text", "text", "text"]}
                          headings={["Email", "Role", "Added", ""]}
                          rows={data.staff.map((entry) => [
                            entry.email,
                            entry.role,
                            new Date(entry.createdAt).toLocaleDateString("en-GB", { timeZone: "UTC" }),
                            <Button
                              key={entry.id}
                              variant="plain"
                              tone="critical"
                              loading={busyIntent === "remove-role"}
                              onClick={() =>
                                submit(
                                  { intent: "remove-role", id: entry.id },
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
                ) : null}

                {selectedTab === 2 ? (
                  <Card>
                    <BlockStack gap="400">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="h2" variant="headingMd">
                          Audit log
                        </Text>
                        <Button
                          loading={busyIntent === "verify-chain"}
                          onClick={() =>
                            submit({ intent: "verify-chain" }, { method: "post" })
                          }
                        >
                          Verify chain
                        </Button>
                      </InlineStack>
                      {actionData?.verify ? (
                        <Banner
                          tone={actionData.verify.ok ? "success" : "critical"}
                          title={
                            actionData.verify.ok
                              ? "Audit chain intact — no tampering detected."
                              : `Audit chain broken at entry #${actionData.verify.brokenAtSeq}.`
                          }
                        />
                      ) : null}
                      <Text as="p" tone="subdued" variant="bodySm">
                        Append-only, hash-chained log of every state change.
                        Each entry&apos;s hash covers the previous one, so any
                        tampering is detectable.
                      </Text>
                      <FormLayout>
                        <FormLayout.Group>
                          <Select
                            label="Actor"
                            options={[
                              { label: "All", value: "" },
                              ...ACTOR_TYPES.map((type) => ({
                                label: type,
                                value: type,
                              })),
                            ]}
                            value={actorFilter}
                            onChange={setActorFilter}
                          />
                          <TextField
                            label="Action contains"
                            value={actionFilter}
                            onChange={setActionFilter}
                            autoComplete="off"
                            placeholder="e.g. settings."
                          />
                          <TextField
                            label="Subject contains"
                            value={subjectFilter}
                            onChange={setSubjectFilter}
                            autoComplete="off"
                            placeholder="Contract id, email…"
                          />
                        </FormLayout.Group>
                        <Button onClick={applyAuditFilters}>Apply filters</Button>
                      </FormLayout>
                      <DataTable
                        columnContentTypes={[
                          "numeric",
                          "text",
                          "text",
                          "text",
                          "text",
                          "text",
                        ]}
                        headings={[
                          "#",
                          "When",
                          "Actor",
                          "Action",
                          "Subject",
                          "Payload",
                        ]}
                        rows={data.audit.rows.map((row) => [
                          row.seq,
                          new Date(row.createdAt).toLocaleString(),
                          row.actorId
                            ? `${row.actorType} · ${row.actorId}`
                            : row.actorType,
                          row.action,
                          row.subjectType
                            ? `${row.subjectType}${row.subjectId ? ` ${row.subjectId}` : ""}`
                            : "—",
                          row.payloadJson.length > 80
                            ? `${row.payloadJson.slice(0, 80)}…`
                            : row.payloadJson,
                        ])}
                      />
                      <InlineStack align="center">
                        <Pagination
                          hasPrevious={data.audit.page > 1}
                          hasNext={data.audit.page < totalAuditPages}
                          onPrevious={() => gotoAuditPage(data.audit.page - 1)}
                          onNext={() => gotoAuditPage(data.audit.page + 1)}
                          label={`Page ${data.audit.page} of ${totalAuditPages} · ${data.audit.total} entries`}
                        />
                      </InlineStack>
                    </BlockStack>
                  </Card>
                ) : null}

                {selectedTab === 3 ? (
                  <BlockStack gap="400">
                    <Card>
                      <BlockStack gap="400">
                        <Text as="h2" variant="headingMd">
                          Reconciliation
                        </Text>
                        <Text as="p" tone="subdued">
                          Compares the local contract mirror against Shopify and
                          repairs any drift. Runs on a schedule via
                          POST /jobs/reconcile; you can also trigger a run now.
                        </Text>
                        <InlineStack>
                          <Button
                            variant="primary"
                            loading={busyIntent === "run-reconcile"}
                            onClick={() =>
                              submit(
                                { intent: "run-reconcile" },
                                { method: "post" },
                              )
                            }
                          >
                            Run reconciliation now
                          </Button>
                        </InlineStack>
                        {actionData?.reconcile != null ? (
                          <Box
                            background="bg-surface-secondary"
                            padding="300"
                            borderRadius="200"
                            overflowX="scroll"
                          >
                            <pre style={{ margin: 0, fontSize: "12px" }}>
                              {JSON.stringify(actionData.reconcile, null, 2)}
                            </pre>
                          </Box>
                        ) : null}
                      </BlockStack>
                    </Card>

                    <Card>
                      <BlockStack gap="300">
                        <Text as="h2" variant="headingMd">
                          Exports
                        </Text>
                        <Text as="p" tone="subdued">
                          CSV exports live next to the data they describe:
                        </Text>
                        <Text as="p" variant="bodySm">
                          • Subscribers and contract details — Subscribers page
                          export.
                        </Text>
                        <Text as="p" variant="bodySm">
                          • Cohorts, survival curves and forecasts — Analytics
                          page exports.
                        </Text>
                        <Text as="p" variant="bodySm">
                          • Raw lifecycle events (AnalyticsEvent) and the audit
                          log — query the database directly (e.g. Prisma Studio)
                          or via your warehouse sync.
                        </Text>
                      </BlockStack>
                    </Card>

                    <Card>
                      <BlockStack gap="300">
                        <Text as="h2" variant="headingMd">
                          GDPR &amp; privacy
                        </Text>
                        <Text as="p" variant="bodySm">
                          • Shopify privacy webhooks (customers/data_request,
                          customers/redact, shop/redact) are handled
                          automatically by the app.
                        </Text>
                        <Text as="p" variant="bodySm">
                          • Klaviyo holds its own copy of profiles and events —
                          erasure requests must also be executed in Klaviyo.
                        </Text>
                        <Text as="p" variant="bodySm">
                          • The audit log is append-only and retains staff
                          emails and action metadata for accountability; it
                          contains no card data. The Klaviyo API key is stored
                          encrypted (AES-256-GCM) and never displayed.
                        </Text>
                      </BlockStack>
                    </Card>
                  </BlockStack>
                ) : null}

                {selectedTab === 4 ? (
                  <Card>
                    <BlockStack gap="400">
                      <Text as="h2" variant="headingMd">
                        General
                      </Text>
                      <FormLayout>
                        <TextField
                          label="Currency code"
                          value={currency}
                          onChange={setCurrency}
                          autoComplete="off"
                          maxLength={3}
                          helpText="ISO 4217, e.g. EUR. Used for admin displays; each treatment plan keeps its own currency."
                        />
                        <TextField
                          label="Free gift threshold (cents)"
                          type="number"
                          value={gift}
                          onChange={setGift}
                          autoComplete="off"
                          min={0}
                          helpText="Deliveries at or above this amount qualify for milestone gifts. All money is integer cents: 15000 = 150.00."
                        />
                        <TextField
                          label="Pre-dunning lead time (days)"
                          type="number"
                          value={lead}
                          onChange={setLead}
                          autoComplete="off"
                          min={0}
                          helpText="How many days before a scheduled charge customers are warned about an expiring card."
                        />
                        <TextField
                          label="High-value grace period (days)"
                          type="number"
                          value={grace}
                          onChange={setGrace}
                          autoComplete="off"
                          min={0}
                          helpText="Extra days a high-value treatment plan stays active after a failed payment before final notice."
                        />
                        <Divider />
                        <Text as="h3" variant="headingSm">
                          Customer policy
                        </Text>
                        <Checkbox
                          label="Minimum pause/cancel window"
                          checked={minWindowOn}
                          onChange={setMinWindowOn}
                          helpText="Applies only to a customer's first treatment plan. Customer Service can always override. Confirm the terms are disclosed at checkout in your markets."
                        />
                        <TextField
                          label="Days after first delivery"
                          type="number"
                          value={minWindowDays}
                          onChange={setMinWindowDays}
                          autoComplete="off"
                          min={1}
                          max={90}
                          disabled={!minWindowOn}
                          helpText="1–90 days. Online pause and cancel unlock this many days after the first delivery."
                        />
                        <Button
                          variant="primary"
                          loading={busyIntent === "save-general"}
                          onClick={() =>
                            submit(
                              {
                                intent: "save-general",
                                currencyCode: currency,
                                giftThresholdCents: gift,
                                preDunningLeadDays: lead,
                                highValueGraceDays: grace,
                                minWindowEnabled: String(minWindowOn),
                                minWindowDays,
                              },
                              { method: "post" },
                            )
                          }
                        >
                          Save general settings
                        </Button>
                      </FormLayout>
                    </BlockStack>
                  </Card>
                ) : null}
              </Box>
            </Tabs>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
