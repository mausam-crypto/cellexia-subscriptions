import { getSetting, setSetting } from "~/lib/settings/settings.server";
import { resolveMailConfig } from "~/lib/notifications/mailer.server";
import { TEMPLATES, type TemplateKey } from "~/lib/notifications/templates.server";
import { EMAIL_CATALOG } from "~/lib/notifications/catalog.server";
import {
  createKlaviyoEvent,
  flowsAuth,
  klaviyoApiList,
  klaviyoApiRequest,
  klaviyoErrorDetail,
  resolveKlaviyoAuth,
  type KlaviyoAuth,
} from "./client.server";
import { CELLEXIA_SEND_PROPERTY } from "./events-map.server";

/**
 * Guided Klaviyo flow setup (v1.18.0).
 *
 * Turns "build a dozen flows by hand in Klaviyo" into one click: for every
 * app-rendered email metric still delivered VIA Klaviyo (sender "auto"/
 * "klaviyo" and enabled — app-delivered or disabled templates are honestly
 * reported, never flowed), the app creates a Klaviyo flow — metric trigger,
 * a `cellexia_send equals "true"` trigger filter, and one email whose
 * subject is `{{ event.content_subject }}` and whose template renders
 * `{{ event.content_html }}` — then sets it live. Klaviyo owns delivery
 * (deliverability, its sending infrastructure); the app owns every word and
 * pixel, which is why these flows never need editing again.
 *
 * Idempotent and merchant-respecting: a metric already covered by ANY live
 * flow (the merchant's own hand-built recipe included) is left alone — the
 * setup never creates a duplicate delivery path. Draft flows WE created are
 * re-PATCHed live on the next run ("click until green"); merchant-owned
 * drafts are never touched.
 *
 * The `cellexia_send` trigger filter is the safety interlock. Since the
 * review hardening its meaning is strict: **"true" = this event carries the
 * app-rendered email content"**. The notifications router stamps "true"
 * only on EMAIL-channel enqueues (which always carry content_subject/
 * content_html); the events-map stamps confirmation events "true" only when
 * person-initiated + enabled + not app-sent + content rendered; every other
 * event — canonical state-change twins, SMS enqueues, setup SEEDS — is
 * "false", so an auto-created flow can never send a blank email and metric
 * seeding can never send anyone anything.
 *
 * API surface: the flows/templates endpoints require revision ≥ 2025-01-15
 * (client.server.ts flowsAuth pins it independently of the events
 * revision). Rate limits are respected: flow creation is paced ~1/s and
 * capped per click (Klaviyo's steady limit is 15/min) — remaining rows get
 * a friendly "click again in a minute" status instead of errors; flow
 * definitions are fetched per flow (the list endpoint cannot embed them)
 * with small pacing.
 */

export { CELLEXIA_SEND_PROPERTY };

// ── Flow specs ───────────────────────────────────────────────────────────────

export interface FlowSpec {
  /** Stable slug (used in reports and tests). */
  key: string;
  metric: string;
  /** Merchant-facing flow name, also the Klaviyo flow name. */
  name: string;
  /** Templates whose delivery rides this metric. */
  templates: TemplateKey[];
  /** Why this email matters — shown in the wizard. */
  why: string;
}

/** Metrics deliberately NOT auto-flowed, with the reason (shown in the UI). */
export const EXCLUDED_FROM_SETUP: Array<{ template: TemplateKey; reason: string }> = [
  {
    template: "threeds_action",
    reason:
      "Bank verification is payment-critical — the app always delivers it directly so it can never wait on (or double with) a marketing tool.",
  },
  {
    template: "payment_failed_sms",
    reason:
      "SMS needs Klaviyo SMS consent and a sending number — build it in Klaviyo when you enable SMS (the event carries the ready-made text).",
  },
  {
    template: "otp_code",
    reason: "Login codes are security mail and never leave the app.",
  },
  {
    template: "admin_alert",
    reason: "Merchant-facing mail, sent directly to you.",
  },
  {
    template: "import_summary",
    reason: "Merchant-facing mail, sent directly to you.",
  },
];

const WHY_BY_METRIC: Record<string, string> = {
  "Cellexia Upcoming Order":
    "The single biggest churn lever: a heads-up with one-tap skip/delay beats a surprise charge followed by a refund-and-cancel.",
  "Cellexia Resume Reminder":
    "Warns before a pause auto-resumes — surprise charges after a break are a top cancellation trigger.",
  "Cellexia Order Confirmed":
    "Reassurance the renewal worked; keeps customers out of 'did it charge me twice?' support tickets.",
  "Cellexia Order Shipped":
    "Anticipation beats impatience — shipping visibility reduces 'where is my order' frustration churn.",
  "Cellexia Payment Failed":
    "The recovery ladder (all three notices ride this one flow) — recovered payments are saved subscribers.",
  "Cellexia Card Expiring":
    "Fixing the card BEFORE it fails avoids the whole dunning journey.",
  "Cellexia Payment Method Updated":
    "Transparency when billing switched to the backup card — surprises erode trust.",
  "Cellexia Gift Scheduled":
    "Announced gifts create anticipation for the next delivery instead of indifference.",
  "Cellexia Milestone Reached":
    "Celebrating tenure makes the subscription feel like progress worth keeping.",
  "Cellexia Rewards Unlocked":
    "Unlocked rewards give a concrete reason not to cancel.",
  "Cellexia Winback Soft Touch":
    "The gentle first win-back touch, timed to when their supply runs low.",
  "Cellexia Winback Perk":
    "The second win-back touch, carrying a one-click reactivation perk.",
  "Cellexia Winback Discount":
    "The final win-back touch — a one-click discounted restart.",
  "Cellexia Price Change Notice":
    "The legally required advance notice — handled badly, price changes are a churn spike.",
  "Cellexia Stockout Delay":
    "Honest stock communication keeps a delayed order from becoming a cancelled subscription.",
  "Cellexia Stockout Skip": "Same — a skipped order explained is a customer kept.",
  "Cellexia Stockout Substitute":
    "Same — a substitution explained is a customer kept.",
  "Cellexia Order Skipped":
    "Confirms the one-tap skip worked — trust in the controls is what makes people skip instead of cancel.",
  "Cellexia Order Unskipped": "Confirms the restored order.",
  "Cellexia Order Delayed":
    "Confirms the delay — the customer chose 'later', not 'never'; confirm it so they trust the button next time.",
  "Cellexia Subscription Paused":
    "Confirms the pause — a confident pause is a retained customer, not a cancellation.",
  "Cellexia Subscription Resumed": "Welcomes them back.",
  "Cellexia Product Swapped":
    "Confirms the swap — flexibility is retention; confirmations make it feel safe.",
  "Cellexia Frequency Changed":
    "Confirms the new rhythm — right-sized frequency prevents 'too much product' churn.",
  "Cellexia Subscription Cancelled":
    "The graceful goodbye that keeps the door open (their benefits stay saved).",
};

/**
 * Every metric the setup manages, grouped from the template registry —
 * EMAIL-channel, metric-carrying, non-critical, non-dormant templates.
 * payment_failed_1/2/3 share one metric and become ONE flow.
 */
export function flowSpecs(): FlowSpec[] {
  const byMetric = new Map<string, FlowSpec>();
  for (const [key, def] of Object.entries(TEMPLATES) as Array<
    [TemplateKey, (typeof TEMPLATES)[TemplateKey]]
  >) {
    if (def.channel !== "EMAIL" || !def.klaviyoMetric || def.critical) continue;
    const entry = EMAIL_CATALOG[key];
    if (entry.dormant) continue;
    const existing = byMetric.get(def.klaviyoMetric);
    if (existing) {
      existing.templates.push(key);
      continue;
    }
    byMetric.set(def.klaviyoMetric, {
      key: def.klaviyoMetric
        .toLowerCase()
        .replace(/^cellexia\s+/, "")
        .replace(/[^a-z0-9]+/g, "_"),
      metric: def.klaviyoMetric,
      name: `Cellexia — ${def.klaviyoMetric.replace(/^Cellexia\s+/, "")}`,
      templates: [key],
      why: WHY_BY_METRIC[def.klaviyoMetric] ?? "",
    });
  }
  return [...byMetric.values()];
}

// ── Effective delivery (sender model awareness) ──────────────────────────────

export type EffectiveDelivery = "klaviyo" | "app" | "off";

/**
 * How a metric is effectively delivered under the shop's `emails` setting
 * (the v1.17.0 sender model): a metric needs a Klaviyo flow only when at
 * least one of its templates still rides Klaviyo delivery. Templates with
 * sender "app" are delivered directly by the app (the router suppresses
 * their delivery metric entirely); disabled disableable templates send
 * nothing. Coverage that ignored this shouted "customers receive nothing"
 * at merchants whose emails were deliberately app-sent — never again.
 */
export function effectiveDeliveryFor(
  spec: FlowSpec,
  emailsTemplates: Record<
    string,
    { enabled?: boolean; sender?: string } | undefined
  >,
): EffectiveDelivery {
  let anyEnabled = false;
  let anyKlaviyo = false;
  for (const template of spec.templates) {
    const override = emailsTemplates[template];
    const entry = EMAIL_CATALOG[template];
    const enabled = !(entry.disableable && override?.enabled === false);
    if (!enabled) continue;
    anyEnabled = true;
    if (override?.sender !== "app") anyKlaviyo = true;
  }
  if (!anyEnabled) return "off";
  return anyKlaviyo ? "klaviyo" : "app";
}

// ── Definition building ──────────────────────────────────────────────────────

function parseFromAddress(from: string): { label: string; email: string } {
  const match = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (match) return { label: match[1] || "Cellexia", email: match[2].trim() };
  if (from.includes("@")) return { label: "Cellexia", email: from.trim() };
  return { label: "Cellexia", email: "no-reply@cellexia.com" };
}

/**
 * The Klaviyo template every auto-created flow uses: the app's rendered
 * email plus the compliance footer Klaviyo requires (unsubscribe + sender
 * identity via organization tags — Klaviyo fills those from account
 * settings, so nothing here goes stale).
 */
export function flowTemplateHtml(): string {
  return `{{ event.content_html }}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  <tr>
    <td align="center" style="padding:8px 16px 24px;font-family:Georgia,'Times New Roman',serif;font-size:12px;line-height:1.6;color:#8a837a;">
      {{ organization.name }} · {{ organization.full_address }}<br>
      <a href="{% unsubscribe_link %}" style="color:#8a837a;">Unsubscribe</a>
    </td>
  </tr>
</table>`;
}

export function flowTemplateText(): string {
  return `{{ event.content_text }}

{{ organization.name }} · {{ organization.full_address }}
Unsubscribe: {% unsubscribe_link %}`;
}

const ENTRY_ACTION_ID = "cellexia-send-email";

/**
 * One-flow definition: metric trigger gated on cellexia_send="true", one
 * send-email action. Smart sending is OFF — these are subscription
 * operations emails (a reminder must not be swallowed because a campaign
 * went out an hour earlier).
 */
export function buildFlowDefinition(input: {
  metricId: string;
  templateId: string;
  flowName: string;
  fromEmail: string;
  fromLabel: string;
  messageStatus: "live" | "draft";
}): Record<string, unknown> {
  return {
    triggers: [
      {
        type: "metric",
        id: input.metricId,
        trigger_filter: {
          condition_groups: [
            {
              conditions: [
                {
                  type: "metric-property",
                  metric_id: input.metricId,
                  field: CELLEXIA_SEND_PROPERTY,
                  filter: {
                    type: "string",
                    operator: "equals",
                    value: "true",
                  },
                },
              ],
            },
          ],
        },
      },
    ],
    profile_filter: null,
    entry_action_id: ENTRY_ACTION_ID,
    actions: [
      {
        temporary_id: ENTRY_ACTION_ID,
        type: "send-email",
        links: { next: null },
        data: {
          message: {
            from_email: input.fromEmail,
            from_label: input.fromLabel,
            reply_to_email: null,
            cc_email: null,
            bcc_email: null,
            subject_line: "{{ event.content_subject }}",
            preview_text: "",
            template_id: input.templateId,
            smart_sending_enabled: false,
            transactional: false,
            add_tracking_params: false,
            custom_tracking_params: null,
            additional_filters: null,
            name: input.flowName,
          },
          status: input.messageStatus,
        },
      },
    ],
  };
}

// ── Klaviyo reads ────────────────────────────────────────────────────────────

export interface MetricIndex {
  ok: boolean;
  status?: number;
  error?: string;
  /** metric name → metric id */
  byName: Map<string, string>;
}

export async function listMetricsByName(auth: KlaviyoAuth): Promise<MetricIndex> {
  const result = await klaviyoApiList(flowsAuth(auth), "/api/metrics/");
  if (!result.ok) {
    return { ok: false, status: result.status, error: result.error, byName: new Map() };
  }
  const byName = new Map<string, string>();
  for (const row of result.data) {
    const id = typeof row.id === "string" ? row.id : null;
    const name = (row.attributes as { name?: unknown } | undefined)?.name;
    if (id && typeof name === "string") byName.set(name, id);
  }
  return { ok: true, byName };
}

export interface KlaviyoFlowInfo {
  id: string;
  name: string;
  status: string;
  /** Metric ids this flow triggers on (from the definition). */
  triggerMetricIds: string[];
}

export interface FlowIndex {
  ok: boolean;
  status?: number;
  error?: string;
  flows: KlaviyoFlowInfo[];
}

const DEFINITION_FETCH_SPACING_MS = 350;

/**
 * Lists flows, then fetches each metric-triggered flow's definition
 * individually — Klaviyo's LIST endpoint cannot embed definitions (that
 * `additional-fields` parameter exists only on Get Flow singular). A failed
 * definition read is FATAL for the whole index, never "no triggers":
 * coverage must not misread an unreadable flow as a missing one and create
 * a duplicate next to it.
 */
export async function listFlowsWithTriggers(
  auth: KlaviyoAuth,
  opts: { paceMs?: number } = {},
): Promise<FlowIndex> {
  const pinned = flowsAuth(auth);
  const listed = await klaviyoApiList(
    pinned,
    "/api/flows/?fields[flow]=name,status,trigger_type",
  );
  if (!listed.ok) {
    return { ok: false, status: listed.status, error: listed.error, flows: [] };
  }
  const flows: KlaviyoFlowInfo[] = [];
  for (const row of listed.data) {
    const id = typeof row.id === "string" ? row.id : null;
    if (!id) continue;
    const attrs = (row.attributes ?? {}) as {
      name?: unknown;
      status?: unknown;
      trigger_type?: unknown;
    };
    const info: KlaviyoFlowInfo = {
      id,
      name: typeof attrs.name === "string" ? attrs.name : "",
      status: typeof attrs.status === "string" ? attrs.status : "",
      triggerMetricIds: [],
    };
    // Only metric-triggered flows can cover a spec; skip the definition
    // fetch for list-triggered/date-triggered flows when the type is known.
    const triggerType =
      typeof attrs.trigger_type === "string" ? attrs.trigger_type : null;
    if (triggerType === null || /metric/i.test(triggerType)) {
      const detail = await klaviyoApiRequest(
        pinned,
        "GET",
        `/api/flows/${id}/?additional-fields[flow]=definition`,
      );
      if (!detail.ok) {
        return {
          ok: false,
          status: detail.status,
          error: `Could not read the definition of flow "${info.name || id}": ${detail.error ?? `HTTP ${detail.status}`}`,
          flows: [],
        };
      }
      const definition = (
        (detail.json as { data?: { attributes?: { definition?: unknown } } })
          ?.data?.attributes?.definition ?? {}
      ) as { triggers?: unknown };
      const triggers = Array.isArray(definition.triggers)
        ? (definition.triggers as Array<{ type?: unknown; id?: unknown }>)
        : [];
      info.triggerMetricIds = triggers
        .filter((t) => t.type === "metric" && typeof t.id === "string")
        .map((t) => t.id as string);
      await sleep(opts.paceMs ?? DEFINITION_FETCH_SPACING_MS);
    }
    flows.push(info);
  }
  return { ok: true, flows };
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

// ── Coverage model ───────────────────────────────────────────────────────────

export type CoverageStatus =
  | "live" // a live flow delivers this metric — green
  | "not_live" // a flow exists but is draft/manual — one click from green
  | "missing" // metric exists in Klaviyo, no flow — emails on this metric go nowhere
  | "pending_metric" // metric not registered in Klaviyo yet (seeded or never fired)
  | "rate_limited" // Klaviyo's creation limit paused this run — click again shortly
  | "app_delivers" // sender "app": Cellexia delivers directly — no flow needed
  | "off" // disabled in-app — deliberately sends nothing
  | "error"; // this row's setup attempt failed — detail says why

export interface CoverageRow {
  key: string;
  metric: string;
  name: string;
  templates: TemplateKey[];
  why: string;
  status: CoverageStatus;
  /** The covering flow (ours or the merchant's own). */
  flowId: string;
  flowName: string;
  /** True when the covering flow is one this setup created ("Cellexia — "). */
  ours: boolean;
  detail: string;
}

/** Statuses that mean "Klaviyo delivery is expected but not happening". */
export const UNCOVERED_STATUSES: ReadonlySet<string> = new Set([
  "missing",
  "not_live",
]);

export function evaluateCoverage(
  specs: FlowSpec[],
  metricByName: Map<string, string>,
  flows: KlaviyoFlowInfo[],
  emailsTemplates: Record<
    string,
    { enabled?: boolean; sender?: string } | undefined
  > = {},
): CoverageRow[] {
  return specs.map((spec) => {
    const base = {
      key: spec.key,
      metric: spec.metric,
      name: spec.name,
      templates: spec.templates,
      why: spec.why,
      flowId: "",
      flowName: "",
      ours: false,
      detail: "",
    };
    const delivery = effectiveDeliveryFor(spec, emailsTemplates);
    const metricId = metricByName.get(spec.metric);
    const matching = metricId
      ? flows.filter((f) => f.triggerMetricIds.includes(metricId))
      : [];
    const live = matching.find((f) => f.status === "live");
    const covering = live ?? matching[0];
    const flowFields = covering
      ? {
          flowId: covering.id,
          flowName: covering.name,
          ours: covering.name.startsWith("Cellexia — "),
        }
      : {};

    if (delivery === "app") {
      return {
        ...base,
        ...flowFields,
        status: "app_delivers" as const,
        detail:
          "Delivered directly by Cellexia (sender setting) — no Klaviyo flow is needed for it.",
      };
    }
    if (delivery === "off") {
      return {
        ...base,
        ...flowFields,
        status: "off" as const,
        detail: "Turned off on the Emails page — deliberately sends nothing.",
      };
    }
    if (!metricId) {
      return {
        ...base,
        status: "pending_metric" as const,
        detail:
          "Klaviyo has not seen this event yet — it appears the first time the moment fires (setup seeds it automatically).",
      };
    }
    if (live) {
      return { ...base, ...flowFields, status: "live" as const };
    }
    if (covering) {
      return {
        ...base,
        ...flowFields,
        status: "not_live" as const,
        detail: covering.name.startsWith("Cellexia — ")
          ? `The flow "${covering.name}" exists but is ${covering.status || "draft"} — re-run setup to set it live.`
          : `Your flow "${covering.name}" exists but is ${covering.status || "draft"} — set it Live in Klaviyo when ready.`,
      };
    }
    return {
      ...base,
      status: "missing" as const,
      detail: "No flow delivers this event — customers receive nothing for it.",
    };
  });
}

// ── Setup orchestration ──────────────────────────────────────────────────────

export interface SetupReport {
  ok: boolean;
  /** Fatal, before any per-flow work (no key / missing read scopes). */
  fatal?: string;
  seeded: string[];
  rows: CoverageRow[];
  checkedAt: string;
}

async function readEmailsTemplates(
  shopId: string,
): Promise<Record<string, { enabled?: boolean; sender?: string } | undefined>> {
  try {
    const emails = await getSetting(shopId, "emails");
    return emails.templates;
  } catch (err) {
    console.error("[klaviyo-flows] emails settings read failed", err);
    return {};
  }
}

function fatalReport(checkedAt: string, fatal: string, seeded: string[] = []): SetupReport {
  return { ok: false, fatal, seeded, rows: [], checkedAt };
}

function metricsFatal(status: number | undefined, error: string | undefined): string {
  return status === 403
    ? "Your Klaviyo key cannot read metrics — it needs the Metrics: Read scope (step 1 below shows how)."
    : `Could not read your Klaviyo metrics: ${error ?? "unknown error"}`;
}

function flowsFatal(status: number | undefined, error: string | undefined): string {
  return status === 403
    ? "Your Klaviyo key cannot read flows — it needs the Flows: Full scope (step 1 below shows how)."
    : `Could not read your Klaviyo flows: ${error ?? "unknown error"}`;
}

const NO_KEY_FATAL =
  "No Klaviyo API key is connected yet — add one under Settings → Klaviyo connection (step 1 below).";

/** Read-only verification — powers the checklist and the daily alert scan. */
export async function verifyFlowCoverage(shopId: string): Promise<SetupReport> {
  const checkedAt = new Date().toISOString();
  const auth = await resolveKlaviyoAuth(shopId);
  if (!auth.apiKey) return fatalReport(checkedAt, NO_KEY_FATAL);

  const specs = flowSpecs();
  const metrics = await listMetricsByName(auth);
  if (!metrics.ok) {
    await persistAttempt(shopId, checkedAt);
    return fatalReport(checkedAt, metricsFatal(metrics.status, metrics.error));
  }
  const flows = await listFlowsWithTriggers(auth);
  if (!flows.ok) {
    await persistAttempt(shopId, checkedAt);
    return fatalReport(checkedAt, flowsFatal(flows.status, flows.error));
  }
  const emailsTemplates = await readEmailsTemplates(shopId);
  const rows = evaluateCoverage(specs, metrics.byName, flows.flows, emailsTemplates);
  const report: SetupReport = { ok: true, seeded: [], rows, checkedAt };
  await persistCoverage(shopId, report, { fromSetup: false });
  return report;
}

/** Klaviyo's Create Flow steady limit is 15/min — pace and cap per click. */
const FLOW_CREATE_SPACING_MS = 1_100;
const FLOW_CREATE_MAX_PER_RUN = 12;

/**
 * In-process re-entrancy guard: two "Create my flows" clicks (double-click,
 * two admin tabs) must not race each other through list-then-create.
 * Per-shop, released in finally; multi-instance hosts additionally rely on
 * the list-before-create idempotency.
 */
const runningSetups = new Set<string>();

/**
 * The one-click setup: seed missing metrics, then for every uncovered
 * Klaviyo-delivered metric create template + flow and set it live; draft
 * flows WE created earlier are re-PATCHed live. Idempotent — safe to click
 * as many times as it takes.
 */
export interface SetupPacing {
  seedPollDelayMs?: number;
  createSpacingMs?: number;
  definitionPaceMs?: number;
}

export async function runGuidedSetup(
  shopId: string,
  seedEmail: string,
  opts: SetupPacing = {},
): Promise<SetupReport> {
  const checkedAt = new Date().toISOString();
  if (runningSetups.has(shopId)) {
    return fatalReport(
      checkedAt,
      "Flow setup is already running in another tab — give it a minute, then check again.",
    );
  }
  runningSetups.add(shopId);
  try {
    return await runGuidedSetupInner(shopId, seedEmail, opts, checkedAt);
  } finally {
    runningSetups.delete(shopId);
  }
}

async function runGuidedSetupInner(
  shopId: string,
  seedEmail: string,
  opts: SetupPacing,
  checkedAt: string,
): Promise<SetupReport> {
  const auth = await resolveKlaviyoAuth(shopId);
  if (!auth.apiKey) return fatalReport(checkedAt, NO_KEY_FATAL);

  const specs = flowSpecs();
  const metrics = await listMetricsByName(auth);
  if (!metrics.ok) {
    await persistAttempt(shopId, checkedAt);
    return fatalReport(checkedAt, metricsFatal(metrics.status, metrics.error));
  }
  const emailsTemplates = await readEmailsTemplates(shopId);

  // ── Seed metrics Klaviyo has never seen (cellexia_send "false" — a seed
  // can never email anyone, even with every flow already live). Only
  // Klaviyo-delivered specs need their metric materialized. seedEmail is a
  // real merchant address resolved by the caller (alerts recipient → shop
  // contact → admin session) — seeds create a Klaviyo profile for it. ──────
  const seeded: string[] = [];
  for (const spec of specs) {
    if (metrics.byName.has(spec.metric)) continue;
    if (effectiveDeliveryFor(spec, emailsTemplates) !== "klaviyo") continue;
    try {
      const result = await createKlaviyoEvent(
        {
          eventName: spec.metric,
          email: seedEmail,
          properties: {
            setup_seed: true,
            [CELLEXIA_SEND_PROPERTY]: "false",
            note: "Cellexia setup — registers this event so a flow can be created; no email was sent.",
          },
        },
        auth,
      );
      if (result.ok) seeded.push(spec.metric);
    } catch (err) {
      console.error("[klaviyo-flows] seed failed", spec.metric, err);
    }
  }
  // Klaviyo ingests events asynchronously; give fresh seeds a short chance
  // to materialize so most stores finish in a single click.
  if (seeded.length > 0) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await sleep(opts.seedPollDelayMs ?? 3_000);
      const again = await listMetricsByName(auth);
      if (again.ok) {
        for (const [name, id] of again.byName) metrics.byName.set(name, id);
      }
      if (seeded.every((m) => metrics.byName.has(m))) break;
    }
  }

  const flows = await listFlowsWithTriggers(auth, {
    paceMs: opts.definitionPaceMs,
  });
  if (!flows.ok) {
    await persistAttempt(shopId, checkedAt);
    return fatalReport(checkedAt, flowsFatal(flows.status, flows.error), seeded);
  }

  const from = parseFromAddress((await resolveMailConfig(shopId)).from);
  const rows = evaluateCoverage(specs, metrics.byName, flows.flows, emailsTemplates);

  let created = 0;
  let rateLimited = false;
  for (const row of rows) {
    // "click until green": drafts WE created get their set-live retried.
    if (row.status === "not_live" && row.ours && row.flowId && !rateLimited) {
      const patched = await setFlowLive(auth, row.flowId);
      if (patched.ok) {
        row.status = "live";
        row.detail = "";
      } else if (patched.rateLimited) {
        rateLimited = true;
      } else {
        row.detail = `Could not set the flow live: ${patched.error} — open it in Klaviyo and click Set Live.`;
      }
      continue;
    }
    if (row.status !== "missing") continue;
    if (rateLimited || created >= FLOW_CREATE_MAX_PER_RUN) {
      row.status = "rate_limited";
      row.detail =
        "Klaviyo limits how fast flows can be created — click “Create my flows” again in a minute to continue.";
      continue;
    }
    const metricId = metrics.byName.get(row.metric);
    if (!metricId) continue;
    try {
      if (created > 0) {
        await sleep(opts.createSpacingMs ?? FLOW_CREATE_SPACING_MS);
      }
      const result = await createFlowForSpec(auth, {
        metricId,
        flowName: row.name,
        fromEmail: from.email,
        fromLabel: from.label,
      });
      if (result.ok) {
        created += 1;
        row.status = result.live ? "live" : "not_live";
        row.flowId = result.flowId;
        row.flowName = row.name;
        row.ours = true;
        row.detail = result.live
          ? ""
          : "Created — re-run setup (or open it in Klaviyo) to set it live.";
      } else if (result.rateLimited) {
        rateLimited = true;
        row.status = "rate_limited";
        row.detail =
          "Klaviyo limits how fast flows can be created — click “Create my flows” again in a minute to continue.";
      } else {
        row.status = "error";
        row.detail = result.error;
      }
    } catch (err) {
      row.status = "error";
      row.detail = err instanceof Error ? err.message : String(err);
    }
  }

  const report: SetupReport = { ok: true, seeded, rows, checkedAt };
  await persistCoverage(shopId, report, { fromSetup: true });
  return report;
}

async function setFlowLive(
  auth: KlaviyoAuth,
  flowId: string,
): Promise<{ ok: boolean; rateLimited?: boolean; error?: string }> {
  const patched = await klaviyoApiRequest(
    flowsAuth(auth),
    "PATCH",
    `/api/flows/${flowId}/`,
    { data: { type: "flow", id: flowId, attributes: { status: "live" } } },
  );
  if (patched.ok) return { ok: true };
  return {
    ok: false,
    rateLimited: patched.status === 429,
    error: patched.error ?? `HTTP ${patched.status}`,
  };
}

/** Creates the per-flow template + the flow, then sets it live. */
async function createFlowForSpec(
  auth: KlaviyoAuth,
  input: {
    metricId: string;
    flowName: string;
    fromEmail: string;
    fromLabel: string;
  },
): Promise<
  | { ok: true; flowId: string; live: boolean }
  | { ok: false; rateLimited?: boolean; error: string }
> {
  const pinned = flowsAuth(auth);

  // 1. Template (reused when a previous run already created it).
  const templateName = `${input.flowName} (app-rendered)`;
  const templateId = await ensureTemplate(pinned, templateName);
  if (!templateId.ok) return templateId;

  // 2. Flow — try with the message live; fall back to draft ONLY on a
  //    definitive rejection (4xx other than 429): a 429 or network failure
  //    must never trigger a second POST (doubled traffic; and a timeout
  //    after server-side success could otherwise create two flows).
  let flowId: string | null = null;
  for (const messageStatus of ["live", "draft"] as const) {
    const definition = buildFlowDefinition({
      metricId: input.metricId,
      templateId: templateId.id,
      flowName: input.flowName,
      fromEmail: input.fromEmail,
      fromLabel: input.fromLabel,
      messageStatus,
    });
    const response = await klaviyoApiRequest(pinned, "POST", "/api/flows/", {
      data: {
        type: "flow",
        attributes: { name: input.flowName, definition },
      },
    });
    if (response.ok) {
      const id = (response.json as { data?: { id?: unknown } })?.data?.id;
      flowId = typeof id === "string" ? id : null;
      break;
    }
    if (response.status === 429) {
      return {
        ok: false,
        rateLimited: true,
        error: "Klaviyo's flow-creation limit was reached",
      };
    }
    if (response.status === 403) {
      return {
        ok: false,
        error:
          "Your Klaviyo key cannot create flows — it needs the Flows: Full scope (step 1 shows how to add it).",
      };
    }
    if (response.status === 0 || response.status >= 500) {
      return {
        ok: false,
        error: `Klaviyo did not accept the flow (${response.error ?? `HTTP ${response.status}`}) — try again in a minute.`,
      };
    }
    if (messageStatus === "draft") {
      return {
        ok: false,
        error: `Klaviyo rejected the flow: ${response.error ?? `HTTP ${response.status}`}`,
      };
    }
    // Definitive 4xx on "live" → retry once with draft.
  }
  if (!flowId) {
    return { ok: false, error: "Klaviyo did not return the new flow's id" };
  }

  // 3. Set the flow live — the FLOW-level status is what governs delivery
  //    (created flows start draft regardless of the message status).
  const patched = await setFlowLive(auth, flowId);
  return { ok: true, flowId, live: patched.ok };
}

async function ensureTemplate(
  auth: KlaviyoAuth,
  name: string,
): Promise<
  | { ok: true; id: string }
  | { ok: false; rateLimited?: boolean; error: string }
> {
  // Reuse an existing template of the same name (idempotent re-runs).
  const existing = await klaviyoApiList(
    auth,
    `/api/templates/?filter=${encodeURIComponent(`equals(name,"${name}")`)}`,
  );
  if (existing.ok) {
    const hit = existing.data.find((t) => typeof t.id === "string");
    if (hit) return { ok: true, id: hit.id as string };
  }
  const response = await klaviyoApiRequest(auth, "POST", "/api/templates/", {
    data: {
      type: "template",
      attributes: {
        name,
        // Klaviyo's enum for custom-HTML templates ("html" is not a value).
        editor_type: "CODE",
        html: flowTemplateHtml(),
        text: flowTemplateText(),
      },
    },
  });
  if (!response.ok) {
    if (response.status === 429) {
      return {
        ok: false,
        rateLimited: true,
        error: "Klaviyo's template-creation limit was reached",
      };
    }
    if (response.status === 403) {
      return {
        ok: false,
        error:
          "Your Klaviyo key cannot create templates — it needs the Templates: Full scope (step 1 shows how to add it).",
      };
    }
    return {
      ok: false,
      error: `Klaviyo rejected the email template: ${
        klaviyoErrorDetail(response.json) ?? response.error ?? `HTTP ${response.status}`
      }`,
    };
  }
  const id = (response.json as { data?: { id?: unknown } })?.data?.id;
  if (typeof id !== "string") {
    return { ok: false, error: "Klaviyo did not return the new template's id" };
  }
  return { ok: true, id };
}

// ── Cached coverage (machine-written setting) ───────────────────────────────

async function persistCoverage(
  shopId: string,
  report: SetupReport,
  opts: { fromSetup: boolean },
): Promise<void> {
  try {
    const previous = await readCachedCoverage(shopId);
    await setSetting(
      shopId,
      "klaviyoFlowSetup",
      {
        checkedAt: report.checkedAt,
        lastAttemptAt: report.checkedAt,
        setupRanAt: opts.fromSetup
          ? report.checkedAt
          : (previous.setupRanAt ?? null),
        rows: report.rows.map((r) => ({
          metric: r.metric,
          status: r.status,
          flowId: r.flowId,
          flowName: r.flowName,
          ours: r.ours,
        })),
      },
      "system",
    );
  } catch (err) {
    console.error("[klaviyo-flows] coverage cache write failed", err);
  }
}

/**
 * Records a FAILED verification attempt without touching the last good
 * verdict — the daily throttle must hold even when every attempt fails
 * (e.g. an Events-only key), or the 15-minute alert sweep would poll
 * Klaviyo 96×/day forever.
 */
async function persistAttempt(shopId: string, attemptAt: string): Promise<void> {
  try {
    const previous = await readCachedCoverage(shopId);
    await setSetting(
      shopId,
      "klaviyoFlowSetup",
      {
        checkedAt: previous.checkedAt,
        lastAttemptAt: attemptAt,
        setupRanAt: previous.setupRanAt ?? null,
        rows: previous.rows,
      },
      "system",
    );
  } catch (err) {
    console.error("[klaviyo-flows] attempt cache write failed", err);
  }
}

export interface CachedCoverage {
  checkedAt: string | null;
  lastAttemptAt: string | null;
  setupRanAt: string | null;
  rows: Array<{
    metric: string;
    status: string;
    flowId: string;
    flowName: string;
    ours: boolean;
  }>;
}

export async function readCachedCoverage(shopId: string): Promise<CachedCoverage> {
  try {
    return (await getSetting(shopId, "klaviyoFlowSetup")) as CachedCoverage;
  } catch {
    return { checkedAt: null, lastAttemptAt: null, setupRanAt: null, rows: [] };
  }
}

/**
 * Daily coverage check for the alert scan. Opt-in and budgeted:
 *  - null until the merchant has actually RUN the guided setup (setupRanAt)
 *    — a merchant who hand-built three flows and never opened the wizard
 *    must never be nagged about the other twenty;
 *  - Klaviyo is consulted at most once per day, counting FAILED attempts
 *    (lastAttemptAt) — an Events-only key must not turn the 15-minute
 *    sweep into a permanent polling loop;
 *  - reports only metrics whose emails are Klaviyo-delivered (the sender
 *    model is folded into the row statuses) yet have no live flow.
 */
export async function staleOrMissingCoverage(
  shopId: string,
  now: Date,
): Promise<{ missing: string[]; checkedAt: string | null } | null> {
  const cached = await readCachedCoverage(shopId);
  if (!cached.setupRanAt) return null; // wizard never completed — never nag
  const lastTouch = [cached.checkedAt, cached.lastAttemptAt]
    .filter((v): v is string => typeof v === "string")
    .sort()
    .pop();
  const ageMs = lastTouch
    ? now.getTime() - new Date(lastTouch).getTime()
    : Number.POSITIVE_INFINITY;
  let rows = cached.rows;
  let checkedAt = cached.checkedAt;
  if (ageMs > 24 * 60 * 60 * 1000) {
    const report = await verifyFlowCoverage(shopId); // persists attempt/result
    if (!report.ok) return null; // can't verify (no key / scopes) — never guess
    rows = report.rows.map((r) => ({
      metric: r.metric,
      status: r.status,
      flowId: r.flowId,
      flowName: r.flowName,
      ours: r.ours,
    }));
    checkedAt = report.checkedAt;
  }
  if (rows.length === 0) return null;
  return {
    missing: rows
      .filter((r) => UNCOVERED_STATUSES.has(r.status))
      .map((r) => r.metric),
    checkedAt,
  };
}
