import { getSetting, setSetting } from "~/lib/settings/settings.server";
import { resolveMailConfig } from "~/lib/notifications/mailer.server";
import { TEMPLATES, type TemplateKey } from "~/lib/notifications/templates.server";
import { EMAIL_CATALOG } from "~/lib/notifications/catalog.server";
import {
  createKlaviyoEvent,
  flowsAuth,
  klaviyoApiRequest,
  klaviyoErrorDetail,
  resolveKlaviyoAuth,
  type KlaviyoApiResponse,
  type KlaviyoAuth,
} from "./client.server";
import { CELLEXIA_SEND_PROPERTY } from "./events-map.server";

/**
 * Guided Klaviyo flow setup (v1.18.0; index + runner reworked in v1.25.0).
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
 * READING KLAVIYO (v1.25.0): coverage is read with ONE paginated request —
 * `GET /api/metrics/?include=flow-triggers` — which returns every metric
 * with the ids of the flows it triggers plus those flows' name/status/
 * archived in `included` (10/s, 150/m). The previous design fetched every
 * metric-triggered flow's DEFINITION one request at a time (Get Flow:
 * 3/s, 60/m), so any account with more than ~50 flows — including the ~27
 * flows this setup itself creates — tripped 429s, and one failed read made
 * the whole index fatal ⇒ an EMPTY checklist. Definitions are never fetched
 * anymore. When the include parameter is rejected (400) the fallback is
 * `GET /api/metrics/` + `GET /api/metrics/{id}/flow-triggers/` for the spec
 * metrics only (10/s, 150/m, paced). Every request goes through a 429-aware
 * retry wrapper (Retry-After honored, capped; GETs also retry 5xx/network;
 * a POST is NEVER re-sent on 5xx — ambiguous — but a 429 POST is safe to
 * retry because nothing was created).
 *
 * WRITING KLAVIYO: creation is paced to Klaviyo's Create Flow limit
 * (1/s burst, 15/min steady, 100/day) — one POST every ≥ 4.1 s, no per-run
 * cap, a 429 waits Retry-After and continues; the whole run lives inside
 * an 8-minute budget (it runs in the background — see setup-task.server.ts
 * — so it may take its time) after which the remaining rows report
 * `rate_limited` and the next click continues from there.
 *
 * FAIL-CLOSED READS: a fatal read never yields an empty checklist — the
 * report carries the last cached rows (specs never verified are
 * "unchecked") and the fatal message sits above them.
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
  "Cellexia Gift Teaser":
    "The 'a surprise is coming' tease before box two — anticipation exactly at the highest-churn charge.",
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

// ── Timing seams (injectable for tests) ──────────────────────────────────────

export type SleepFn = (ms: number) => Promise<void>;
export type NowFn = () => number;

function defaultSleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/** Clock + sleep pair every waiting path uses; tests inject a fake clock. */
export interface TimingOptions {
  sleep?: SleepFn;
  now?: NowFn;
}

// ── Retry wrapper (429 / transient) ──────────────────────────────────────────

const RETRY_MAX_ATTEMPTS = 4;
/** Retry-After ceiling — a multi-minute hint (daily cap) is not worth blocking on. */
const RETRY_AFTER_CAP_MS = 30_000;
/** Backoff when Klaviyo sends no Retry-After (429) or for 5xx/network on GET. */
const RETRY_FALLBACK_BACKOFF_MS = [2_000, 5_000, 10_000];
/** Total waiting allowed inside ONE wrapped call. */
const RETRY_DEFAULT_BUDGET_MS = 90_000;

interface RetryOptions extends TimingOptions {
  /** Ceiling on the waits performed inside this call (ms). */
  budgetMs?: number;
}

/**
 * The one door every flows/templates/metrics request goes through. Klaviyo
 * enforces fixed burst + steady windows and answers 429 with Retry-After;
 * the raw client (client.server.ts) never retries, which is right for the
 * outbox (its own backoff) but turned every burst into a fatal read here.
 *
 *  - 429: wait Retry-After (capped) — or 2/5/10 s without one — and retry,
 *    for ANY method: a 429 means the request was not processed.
 *  - 5xx / network (status 0): retry for GET only. A POST /api/flows/ that
 *    timed out may well have created the flow server-side — re-POSTing
 *    would double it — so writes report the ambiguity instead.
 *  - Up to 4 attempts, never waiting past `budgetMs` in total.
 */
async function requestWithRetry(
  auth: KlaviyoAuth,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
  opts: RetryOptions = {},
): Promise<KlaviyoApiResponse> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const budgetMs = opts.budgetMs ?? RETRY_DEFAULT_BUDGET_MS;
  const startedAt = now();
  let last: KlaviyoApiResponse;
  for (let attempt = 0; ; attempt += 1) {
    last = await klaviyoApiRequest(auth, method, path, body);
    if (last.ok) return last;
    const rateLimited = last.status === 429;
    const transient =
      method === "GET" && (last.status === 0 || last.status >= 500);
    if (!rateLimited && !transient) return last;
    if (attempt + 1 >= RETRY_MAX_ATTEMPTS) return last;
    const fallback =
      RETRY_FALLBACK_BACKOFF_MS[
        Math.min(attempt, RETRY_FALLBACK_BACKOFF_MS.length - 1)
      ];
    const waitMs =
      rateLimited && last.retryAfterSeconds && last.retryAfterSeconds > 0
        ? Math.min(last.retryAfterSeconds * 1000, RETRY_AFTER_CAP_MS)
        : fallback;
    if (now() - startedAt + waitMs > budgetMs) return last;
    await sleep(waitMs);
  }
}

/**
 * Fetches every page of a JSON:API collection through the retry wrapper,
 * keeping BOTH `data` and `included` (the metric→flow index rides the
 * compound document). MAX_PAGES bounds a runaway cursor.
 */
async function listWithRetry(
  auth: KlaviyoAuth,
  path: string,
  opts: RetryOptions = {},
): Promise<
  | {
      ok: true;
      data: Array<Record<string, unknown>>;
      included: Array<Record<string, unknown>>;
    }
  | { ok: false; status: number; error: string }
> {
  const MAX_PAGES = 30;
  const data: Array<Record<string, unknown>> = [];
  const included: Array<Record<string, unknown>> = [];
  let next: string | null = path;
  for (let page = 0; page < MAX_PAGES && next; page += 1) {
    const response = await requestWithRetry(auth, "GET", next, undefined, opts);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: response.error ?? `Klaviyo ${response.status}`,
      };
    }
    const body = response.json as {
      data?: unknown;
      included?: unknown;
      links?: { next?: unknown };
    };
    if (Array.isArray(body?.data)) {
      data.push(...(body.data as Array<Record<string, unknown>>));
    }
    if (Array.isArray(body?.included)) {
      included.push(...(body.included as Array<Record<string, unknown>>));
    }
    next = typeof body?.links?.next === "string" ? body.links.next : null;
  }
  return { ok: true, data, included };
}

// ── Klaviyo reads ────────────────────────────────────────────────────────────

export interface MetricIndex {
  ok: boolean;
  status?: number;
  error?: string;
  /** metric name → metric id */
  byName: Map<string, string>;
}

/**
 * Klaviyo keeps ONE metric per (name, integration). The app posts its
 * events through the Events API with no `service`, so every "Cellexia …"
 * metric the app fires lives under the "API" integration; a same-named
 * metric under another integration (a past Zapier/custom test) is a
 * distinct id that the app's events never touch. Judging coverage against
 * — or building a flow trigger on — that other id would paint a row green
 * while the real events fire nothing.
 */
function isApiIntegration(attributes: Record<string, unknown> | undefined): boolean {
  const integration = attributes?.integration as
    | { name?: unknown; category?: unknown; key?: unknown }
    | undefined;
  if (!integration) return false;
  const tag = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase() : "");
  return (
    tag(integration.name) === "api" ||
    tag(integration.category) === "api" ||
    tag(integration.key) === "api"
  );
}

/**
 * name → id index with a deterministic collision rule: the API-integration
 * metric wins over any other integration; among equals the FIRST listed is
 * kept (never last-writer-wins). Collisions are logged so a wrong pick is
 * diagnosable.
 */
class MetricNameIndex {
  readonly byName = new Map<string, string>();
  private readonly apiPicked = new Set<string>();
  private readonly collided = new Set<string>();

  add(resource: Record<string, unknown>): void {
    const id = typeof resource.id === "string" ? resource.id : null;
    const attributes = resource.attributes as Record<string, unknown> | undefined;
    const name = attributes?.name;
    if (!id || typeof name !== "string") return;
    const api = isApiIntegration(attributes);
    const existing = this.byName.get(name);
    if (existing === undefined) {
      this.byName.set(name, id);
      if (api) this.apiPicked.add(name);
      return;
    }
    if (existing === id) return;
    if (!this.collided.has(name)) {
      this.collided.add(name);
      console.warn(
        `[klaviyo-flows] metric name collision "${name}": ${existing} and ${id} (keeping the API-integration one, else the first listed)`,
      );
    }
    if (api && !this.apiPicked.has(name)) {
      this.byName.set(name, id);
      this.apiPicked.add(name);
    }
  }
}

/** Plain metric listing (name → id) — used by the seed poll. */
export async function listMetricsByName(
  auth: KlaviyoAuth,
  opts: RetryOptions = {},
): Promise<MetricIndex> {
  const result = await listWithRetry(flowsAuth(auth), "/api/metrics/", opts);
  if (!result.ok) {
    return { ok: false, status: result.status, error: result.error, byName: new Map() };
  }
  const index = new MetricNameIndex();
  for (const row of result.data) index.add(row);
  return { ok: true, byName: index.byName };
}

export interface KlaviyoFlowInfo {
  id: string;
  name: string;
  status: string;
  /** Metric ids this flow triggers on (from the metric→flow-triggers index). */
  triggerMetricIds: string[];
}

export interface FlowIndex {
  ok: boolean;
  status?: number;
  error?: string;
  flows: KlaviyoFlowInfo[];
}

/** Metrics AND the flows they trigger, from one read. */
export interface MetricFlowIndex extends FlowIndex {
  byName: Map<string, string>;
  /** Which read path produced it (diagnostics). */
  source: "include" | "per_metric" | null;
}

/** Klaviyo lists ≤ 200 metrics per page; the flow fields we need. */
const METRICS_WITH_FLOWS_PATH =
  "/api/metrics/?include=flow-triggers&fields[flow]=name,status,archived,trigger_type,updated";
/** Per-metric fallback (10/s, 150/m) — paced well under the burst window. */
const FLOW_TRIGGERS_PACE_MS = 120;

type FlowsById = Map<string, KlaviyoFlowInfo>;

/**
 * Registers a flow resource object; archived flows are remembered in
 * `archived` and never indexed — an archived flow delivers nothing, so it
 * must not count as coverage (its triggers are skipped too).
 */
function registerFlow(
  flowsById: FlowsById,
  archived: Set<string>,
  resource: Record<string, unknown>,
): void {
  const id = typeof resource.id === "string" ? resource.id : null;
  if (!id) return;
  const attrs = (resource.attributes ?? {}) as {
    name?: unknown;
    status?: unknown;
    archived?: unknown;
  };
  if (attrs.archived === true) {
    archived.add(id);
    return;
  }
  const existing = flowsById.get(id);
  flowsById.set(id, {
    id,
    name: typeof attrs.name === "string" ? attrs.name : (existing?.name ?? ""),
    status:
      typeof attrs.status === "string" ? attrs.status : (existing?.status ?? ""),
    triggerMetricIds: existing?.triggerMetricIds ?? [],
  });
}

/** Adds metricId to the flow's trigger list (one flow may sit under several metrics). */
function linkFlowToMetric(
  flowsById: FlowsById,
  archived: Set<string>,
  flowId: string,
  metricId: string,
): void {
  if (archived.has(flowId)) return;
  const info = flowsById.get(flowId) ?? {
    // Referenced but not present in `included` — unknown status. Kept (as
    // a non-live flow) rather than dropped: an unreadable flow must never
    // read as "no flow here" and cause a duplicate.
    id: flowId,
    name: "",
    status: "",
    triggerMetricIds: [],
  };
  if (!info.triggerMetricIds.includes(metricId)) info.triggerMetricIds.push(metricId);
  flowsById.set(flowId, info);
}

/**
 * The v1.25.0 index: ONE paginated request returns every metric with its
 * triggering flow ids (relationships["flow-triggers"]) and, via `included`,
 * the flows' name/status/archived — no per-flow definition reads. When the
 * include parameter is rejected with 400 (older account/revision quirk),
 * falls back to the metric list plus per-metric flow-triggers reads for the
 * SPEC metrics only.
 */
export async function listMetricFlowIndex(
  auth: KlaviyoAuth,
  opts: RetryOptions & { specMetrics?: string[] } = {},
): Promise<MetricFlowIndex> {
  const pinned = flowsAuth(auth);
  const names = new MetricNameIndex();
  const byName = names.byName;
  const flowsById = new Map<string, KlaviyoFlowInfo>();
  const archived = new Set<string>();

  const primary = await listWithRetry(pinned, METRICS_WITH_FLOWS_PATH, opts);
  if (primary.ok) {
    for (const resource of primary.included) {
      if (resource.type === "flow") registerFlow(flowsById, archived, resource);
    }
    for (const metric of primary.data) {
      const id = typeof metric.id === "string" ? metric.id : null;
      const name = (metric.attributes as { name?: unknown } | undefined)?.name;
      if (!id || typeof name !== "string") continue;
      names.add(metric);
      const rel = (
        metric.relationships as
          | { "flow-triggers"?: { data?: unknown } }
          | undefined
      )?.["flow-triggers"]?.data;
      if (!Array.isArray(rel)) continue;
      for (const ref of rel as Array<{ id?: unknown }>) {
        if (typeof ref.id === "string") {
          linkFlowToMetric(flowsById, archived, ref.id, id);
        }
      }
    }
    return { ok: true, byName, flows: [...flowsById.values()], source: "include" };
  }
  if (primary.status !== 400) {
    return {
      ok: false,
      status: primary.status,
      error: primary.error,
      byName,
      flows: [],
      source: null,
    };
  }

  // ── Fallback: metrics, then flow-triggers per SPEC metric only. ──────────
  const metrics = await listMetricsByName(pinned, opts);
  if (!metrics.ok) {
    return {
      ok: false,
      status: metrics.status,
      error: metrics.error,
      byName,
      flows: [],
      source: null,
    };
  }
  for (const [name, id] of metrics.byName) byName.set(name, id);
  const wanted = opts.specMetrics ?? flowSpecs().map((s) => s.metric);
  const sleep = opts.sleep ?? defaultSleep;
  let first = true;
  for (const metricName of wanted) {
    const metricId = byName.get(metricName);
    if (!metricId) continue;
    if (!first) await sleep(FLOW_TRIGGERS_PACE_MS);
    first = false;
    const triggered = await listWithRetry(
      pinned,
      `/api/metrics/${metricId}/flow-triggers/?fields[flow]=name,status,archived`,
      opts,
    );
    if (!triggered.ok) {
      return {
        ok: false,
        status: triggered.status,
        error: `Could not read the flows triggered by "${metricName}": ${triggered.error}`,
        byName,
        flows: [],
        source: null,
      };
    }
    for (const resource of triggered.data) {
      registerFlow(flowsById, archived, resource);
      if (typeof resource.id === "string") {
        linkFlowToMetric(flowsById, archived, resource.id, metricId);
      }
    }
  }
  return { ok: true, byName, flows: [...flowsById.values()], source: "per_metric" };
}

// ── Coverage model ───────────────────────────────────────────────────────────

export type CoverageStatus =
  | "live" // a live flow delivers this metric — green
  | "not_live" // a flow exists but is draft/manual — one click from green
  | "missing" // metric exists in Klaviyo, no flow — emails on this metric go nowhere
  | "pending_metric" // metric not registered in Klaviyo yet (seeded or never fired)
  | "rate_limited" // Klaviyo's creation limit ended this run early — the next run continues
  | "app_delivers" // sender "app": Cellexia delivers directly — no flow needed
  | "off" // disabled in-app — deliberately sends nothing
  | "error" // this row's setup attempt failed — detail says why
  | "unchecked"; // never verified yet (no cached verdict for this spec)

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

const OURS_PREFIX = "Cellexia — ";

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
          ours: covering.name.startsWith(OURS_PREFIX),
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
        detail: covering.name.startsWith(OURS_PREFIX)
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
  /**
   * One row per spec — on a fatal read these are the LAST CACHED rows (or
   * "unchecked"), never an empty table while a key is connected.
   */
  rows: CoverageRow[];
  checkedAt: string;
}

export type SetupStep =
  | "reading"
  | "seeding"
  | "waiting_metrics"
  | "setting_live"
  | "creating"
  | "verifying"
  | "done";

export interface SetupProgress {
  step: SetupStep;
  done: number;
  total: number;
  message: string;
}

export type ProgressFn = (progress: SetupProgress) => void;

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

/** A fatal report keeps the last-known rows — the checklist never blanks. */
async function fatalReport(
  shopId: string,
  checkedAt: string,
  fatal: string,
  seeded: string[] = [],
): Promise<SetupReport> {
  return { ok: false, fatal, seeded, rows: await cachedCoverageRows(shopId), checkedAt };
}

function indexFatal(status: number | undefined, error: string | undefined): string {
  return status === 403
    ? "Your Klaviyo key cannot read metrics and flows — it needs the Metrics: Read and Flows: Full scopes (step 1 below shows how)."
    : `Could not read your Klaviyo metrics and flows: ${error ?? "unknown error"}`;
}

const NO_KEY_FATAL =
  "No Klaviyo API key is connected yet — add one under Settings → Klaviyo connection (step 1 below).";

/** Progress callbacks are UI sugar — a throwing listener must never break a run. */
function reportProgress(onProgress: ProgressFn | undefined, progress: SetupProgress): void {
  if (!onProgress) return;
  try {
    onProgress(progress);
  } catch (err) {
    console.error("[klaviyo-flows] progress listener failed", err);
  }
}

export interface VerifyOptions extends TimingOptions {
  onProgress?: ProgressFn;
}

/** Read-only verification — powers the checklist and the daily alert scan. */
export async function verifyFlowCoverage(
  shopId: string,
  opts: VerifyOptions = {},
): Promise<SetupReport> {
  const checkedAt = new Date().toISOString();
  reportProgress(opts.onProgress, {
    step: "reading",
    done: 0,
    total: 0,
    message: "Reading your Klaviyo metrics and flows…",
  });
  const auth = await resolveKlaviyoAuth(shopId);
  if (!auth.apiKey) return fatalReport(shopId, checkedAt, NO_KEY_FATAL);

  const specs = flowSpecs();
  const index = await listMetricFlowIndex(auth, {
    sleep: opts.sleep,
    now: opts.now,
    specMetrics: specs.map((s) => s.metric),
  });
  if (!index.ok) {
    await persistAttempt(shopId, checkedAt);
    return fatalReport(shopId, checkedAt, indexFatal(index.status, index.error));
  }
  const emailsTemplates = await readEmailsTemplates(shopId);
  const rows = evaluateCoverage(specs, index.byName, index.flows, emailsTemplates);
  const report: SetupReport = { ok: true, seeded: [], rows, checkedAt };
  await persistCoverage(shopId, report, { fromSetup: false });
  reportProgress(opts.onProgress, {
    step: "done",
    done: rows.length,
    total: rows.length,
    message: "Checklist refreshed.",
  });
  return report;
}

/**
 * Klaviyo's Create Flow limit is 1/s burst, 15/min steady, 100/day —
 * ≥ 4.1 s between POSTs keeps a full run under the steady window without
 * ever tripping it. Set-live PATCHes are 3/s, 60/m.
 */
const FLOW_CREATE_SPACING_MS = 4_100;
const FLOW_PATCH_SPACING_MS = 1_100;
/** Seeds materialize asynchronously — poll a few times before giving up. */
const SEED_POLL_DELAY_MS = 3_000;
const SEED_POLL_ATTEMPTS = 5;
/**
 * Overall run budget. Runs execute in the background (setup-task.server.ts),
 * so this only bounds pathological cases (Klaviyo answering 429 for
 * minutes); rows left over report `rate_limited` and the next click
 * continues from where this run stopped. Setting-free on purpose — it is
 * a safety valve, not a merchant policy.
 */
const SETUP_RUN_BUDGET_MS = 8 * 60_000;

const RATE_LIMITED_DETAIL =
  "Klaviyo is busy (its flow-creation limit) — the next “Create my flows” click continues from here.";

/**
 * In-process re-entrancy guard: two "Create my flows" clicks (double-click,
 * two admin tabs) must not race each other through list-then-create.
 * Per-shop, released in finally. Across processes the background task
 * runner (setup-task.server.ts) holds a DB lease per shop for the run —
 * list-before-create is idempotent only for SEQUENTIAL runs (two
 * concurrent runs both list before either creates), so the lease, not the
 * idempotency, is what prevents duplicate flows on multi-instance hosts.
 */
const runningSetups = new Set<string>();

export interface SetupPacing extends TimingOptions {
  seedPollDelayMs?: number;
  createSpacingMs?: number;
  patchSpacingMs?: number;
}

export interface SetupOptions extends SetupPacing {
  onProgress?: ProgressFn;
}

/**
 * The one-click setup: seed missing metrics, then for every uncovered
 * Klaviyo-delivered metric create template + flow and set it live; draft
 * flows WE created earlier are re-PATCHed live. Idempotent — safe to click
 * as many times as it takes. Progress is reported per phase so the UI can
 * show "Creating flow 4 of 12 — …" while it runs in the background.
 */
export async function runGuidedSetup(
  shopId: string,
  seedEmail: string,
  opts: SetupOptions = {},
): Promise<SetupReport> {
  const checkedAt = new Date().toISOString();
  if (runningSetups.has(shopId)) {
    return fatalReport(
      shopId,
      checkedAt,
      "Flow setup is already running in another tab — follow its progress there, then check again.",
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
  opts: SetupOptions,
  checkedAt: string,
): Promise<SetupReport> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const remainingBudget = (): number => SETUP_RUN_BUDGET_MS - (now() - startedAt);
  const timing = { sleep, now };
  const progress = (p: SetupProgress): void => reportProgress(opts.onProgress, p);

  progress({ step: "reading", done: 0, total: 0, message: "Reading your Klaviyo metrics and flows…" });
  const auth = await resolveKlaviyoAuth(shopId);
  if (!auth.apiKey) return fatalReport(shopId, checkedAt, NO_KEY_FATAL);

  const specs = flowSpecs();
  const index = await listMetricFlowIndex(auth, {
    ...timing,
    specMetrics: specs.map((s) => s.metric),
  });
  if (!index.ok) {
    await persistAttempt(shopId, checkedAt);
    return fatalReport(shopId, checkedAt, indexFatal(index.status, index.error));
  }
  const byName = index.byName;
  const emailsTemplates = await readEmailsTemplates(shopId);

  // ── Seed metrics Klaviyo has never seen (cellexia_send "false" — a seed
  // can never email anyone, even with every flow already live). Only
  // Klaviyo-delivered specs need their metric materialized. seedEmail is a
  // real merchant address resolved by the caller (alerts recipient → shop
  // contact → admin session) — seeds create a Klaviyo profile for it. ──────
  const seeded: string[] = [];
  const toSeed = specs.filter(
    (spec) =>
      !byName.has(spec.metric) &&
      effectiveDeliveryFor(spec, emailsTemplates) === "klaviyo",
  );
  for (const [i, spec] of toSeed.entries()) {
    progress({
      step: "seeding",
      done: i,
      total: toSeed.length,
      message: `Introducing “${spec.metric}” to Klaviyo (${i + 1} of ${toSeed.length}) — no email is sent…`,
    });
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
  // to materialize so most stores finish in a single run.
  if (seeded.length > 0) {
    for (let attempt = 0; attempt < SEED_POLL_ATTEMPTS; attempt += 1) {
      progress({
        step: "waiting_metrics",
        done: attempt,
        total: SEED_POLL_ATTEMPTS,
        message: `Waiting for Klaviyo to register ${seeded.length} new event${seeded.length === 1 ? "" : "s"}…`,
      });
      await sleep(opts.seedPollDelayMs ?? SEED_POLL_DELAY_MS);
      const again = await listMetricsByName(auth, timing);
      if (again.ok) {
        for (const [name, id] of again.byName) byName.set(name, id);
      }
      if (seeded.every((m) => byName.has(m))) break;
    }
  }

  const from = parseFromAddress((await resolveMailConfig(shopId)).from);
  const rows = evaluateCoverage(specs, byName, index.flows, emailsTemplates);

  // ── "Click until green": drafts WE created get their set-live retried.
  // Merchant-owned drafts are never touched. ────────────────────────────────
  const ourDrafts = rows.filter((r) => r.status === "not_live" && r.ours && r.flowId);
  for (const [i, row] of ourDrafts.entries()) {
    progress({
      step: "setting_live",
      done: i,
      total: ourDrafts.length,
      message: `Setting “${row.name}” live (${i + 1} of ${ourDrafts.length})…`,
    });
    if (i > 0) await sleep(opts.patchSpacingMs ?? FLOW_PATCH_SPACING_MS);
    const patched = await setFlowLive(auth, row.flowId, {
      ...timing,
      budgetMs: Math.max(0, Math.min(RETRY_DEFAULT_BUDGET_MS, remainingBudget())),
    });
    if (patched.ok) {
      row.status = "live";
      row.detail = "";
    } else if (patched.rateLimited) {
      row.status = "rate_limited";
      row.detail = RATE_LIMITED_DETAIL;
    } else {
      row.detail = `Could not set the flow live: ${patched.error} — open it in Klaviyo and click Set Live.`;
    }
  }

  // ── Create every missing flow, paced to Klaviyo's Create Flow limit. ─────
  const toCreate = rows.filter((r) => r.status === "missing" && byName.has(r.metric));
  let created = 0;
  let stopped = false;
  for (const [i, row] of toCreate.entries()) {
    if (stopped || remainingBudget() <= 0) {
      row.status = "rate_limited";
      row.detail = RATE_LIMITED_DETAIL;
      continue;
    }
    const metricId = byName.get(row.metric)!;
    progress({
      step: "creating",
      done: i,
      total: toCreate.length,
      message: `Creating flow ${i + 1} of ${toCreate.length} — ${row.name}…`,
    });
    try {
      if (created > 0) {
        await sleep(opts.createSpacingMs ?? FLOW_CREATE_SPACING_MS);
      }
      const result = await createFlowForSpec(
        auth,
        {
          metricId,
          flowName: row.name,
          fromEmail: from.email,
          fromLabel: from.label,
        },
        {
          ...timing,
          budgetMs: Math.max(0, Math.min(RETRY_DEFAULT_BUDGET_MS, remainingBudget())),
        },
      );
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
        // The wrapper already waited Retry-After (several times). A 429
        // that survives that is sustained (daily cap) — stop politely; the
        // next run continues from here.
        stopped = true;
        row.status = "rate_limited";
        row.detail = RATE_LIMITED_DETAIL;
      } else {
        row.status = "error";
        row.detail = result.error;
      }
    } catch (err) {
      row.status = "error";
      row.detail = err instanceof Error ? err.message : String(err);
    }
  }

  // ── Verify: one cheap re-read resolves ambiguities (a POST that timed
  // out after Klaviyo created the flow shows up here) — contained: a
  // failed re-read keeps the run's own rows. ──────────────────────────────
  progress({ step: "verifying", done: 0, total: 0, message: "Verifying your flows in Klaviyo…" });
  let finalRows = rows;
  try {
    const fresh = await listMetricFlowIndex(auth, {
      ...timing,
      specMetrics: specs.map((s) => s.metric),
    });
    if (fresh.ok) {
      for (const [name, id] of byName) {
        if (!fresh.byName.has(name)) fresh.byName.set(name, id);
      }
      const freshRows = evaluateCoverage(specs, fresh.byName, fresh.flows, emailsTemplates);
      finalRows = rows.map((row, i) => mergeVerifiedRow(row, freshRows[i]));
    }
  } catch (err) {
    console.error("[klaviyo-flows] post-setup verification failed", err);
  }

  const report: SetupReport = { ok: true, seeded, rows: finalRows, checkedAt };
  await persistCoverage(shopId, report, { fromSetup: true });
  const live = finalRows.filter((r) => r.status === "live").length;
  progress({
    step: "done",
    done: finalRows.length,
    total: finalRows.length,
    message: `${live} of ${finalRows.length} emails delivered by a live flow.`,
  });
  return report;
}

/**
 * Fresh Klaviyo truth wins where it is GOOD news or resolves an ambiguity
 * (a live flow; a covering flow behind an error/rate-limited/missing row);
 * otherwise the run's own row (with its actionable detail) stays.
 */
function mergeVerifiedRow(runRow: CoverageRow, freshRow: CoverageRow): CoverageRow {
  if (freshRow.status === "live") return freshRow;
  if (
    freshRow.flowId &&
    (runRow.status === "error" ||
      runRow.status === "rate_limited" ||
      runRow.status === "missing")
  ) {
    return freshRow;
  }
  return runRow;
}

async function setFlowLive(
  auth: KlaviyoAuth,
  flowId: string,
  retry: RetryOptions,
): Promise<{ ok: boolean; rateLimited?: boolean; error?: string }> {
  const patched = await requestWithRetry(
    flowsAuth(auth),
    "PATCH",
    `/api/flows/${flowId}/`,
    { data: { type: "flow", id: flowId, attributes: { status: "live" } } },
    retry,
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
  retry: RetryOptions,
): Promise<
  | { ok: true; flowId: string; live: boolean }
  | { ok: false; rateLimited?: boolean; error: string }
> {
  const pinned = flowsAuth(auth);

  // 1. Template (reused when a previous run already created it).
  const templateName = `${input.flowName} (app-rendered)`;
  const templateId = await ensureTemplate(pinned, templateName, retry);
  if (!templateId.ok) return templateId;

  // 2. Flow — try with the message live; fall back to draft ONLY on a
  //    definitive rejection (4xx other than 429): a 429 is retried inside
  //    the wrapper (nothing was created); a 5xx/network failure must never
  //    trigger a second POST (a timeout after server-side success would
  //    otherwise create two flows — the post-run verification resolves it).
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
    const response = await requestWithRetry(
      pinned,
      "POST",
      "/api/flows/",
      {
        data: {
          type: "flow",
          attributes: { name: input.flowName, definition },
        },
      },
      retry,
    );
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
  const patched = await setFlowLive(auth, flowId, retry);
  return { ok: true, flowId, live: patched.ok };
}

async function ensureTemplate(
  auth: KlaviyoAuth,
  name: string,
  retry: RetryOptions,
): Promise<
  | { ok: true; id: string }
  | { ok: false; rateLimited?: boolean; error: string }
> {
  // Reuse an existing template of the same name (idempotent re-runs).
  const existing = await listWithRetry(
    auth,
    `/api/templates/?filter=${encodeURIComponent(`equals(name,"${name}")`)}`,
    retry,
  );
  if (existing.ok) {
    const hit = existing.data.find((t) => typeof t.id === "string");
    if (hit) return { ok: true, id: hit.id as string };
  }
  const response = await requestWithRetry(
    auth,
    "POST",
    "/api/templates/",
    {
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
    },
    retry,
  );
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

/**
 * Background task record persisted beside the coverage cache (v1.25.0) so
 * other instances/tabs/reloads can follow a run. Owned by
 * setup-task.server.ts (which re-exports it as FlowTaskState); declared
 * here because the persistence layer is here.
 */
export interface FlowTaskRecord {
  id: string;
  kind: "verify" | "setup";
  state: "running" | "done" | "failed";
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** Machine step (SetupStep or "starting"). */
  step: string;
  /** Human progress line ("Creating flow 4 of 12 — …"). */
  message: string;
  done: number;
  total: number;
  report: SetupReport | null;
  error: string | null;
}

export interface CachedCoverageRow {
  metric: string;
  status: string;
  flowId: string;
  flowName: string;
  ours: boolean;
  detail: string;
}

export interface CachedCoverage {
  checkedAt: string | null;
  lastAttemptAt: string | null;
  setupRanAt: string | null;
  rows: CachedCoverageRow[];
  task: FlowTaskRecord | null;
}

const EMPTY_CACHE: CachedCoverage = {
  checkedAt: null,
  lastAttemptAt: null,
  setupRanAt: null,
  rows: [],
  task: null,
};

/**
 * A persisted "running" task record not touched for this long is dead (its
 * process died) — the alert sweep and the task runner share the rule.
 * Technical liveness limit, not a merchant policy.
 */
export const FLOW_TASK_STALE_MS = 90_000;

/** True while the persisted task record says a run is alive right now. */
export function isFreshRunningTask(task: FlowTaskRecord | null, now: Date): boolean {
  if (!task || task.state !== "running") return false;
  const age = now.getTime() - new Date(task.updatedAt).getTime();
  return Number.isFinite(age) && age <= FLOW_TASK_STALE_MS;
}

function normalizeCoverage(raw: Partial<CachedCoverage>): CachedCoverage {
  return {
    checkedAt: raw.checkedAt ?? null,
    lastAttemptAt: raw.lastAttemptAt ?? null,
    setupRanAt: raw.setupRanAt ?? null,
    rows: (raw.rows ?? []).map((r) => ({ ...r, detail: r.detail ?? "" })),
    task: raw.task ?? null,
  };
}

/** Lenient read for DISPLAY: an unreadable cache renders as "not checked yet". */
export async function readCachedCoverage(shopId: string): Promise<CachedCoverage> {
  try {
    return normalizeCoverage(
      (await getSetting(shopId, "klaviyoFlowSetup")) as Partial<CachedCoverage>,
    );
  } catch {
    return { ...EMPTY_CACHE };
  }
}

/**
 * Serialized read-modify-write on the `klaviyoFlowSetup` setting. Coverage
 * rows (persistCoverage) and task progress (setup-task.server.ts) are
 * written by the SAME background run interleaved — two unserialized
 * upserts could let a throttled progress write clobber the freshly stored
 * rows with the stale copy it read a moment earlier. Per-shop chain,
 * in-process; the row is single-writer per run in practice.
 *
 * The read inside the chain is STRICT (no swallow): a transient DB error on
 * the read must abort this write, never masquerade as "empty cache" — a
 * run performs dozens of these writes (progress, heartbeat), and one blip
 * rebuilt from EMPTY_CACHE would wipe rows, checkedAt and setupRanAt (the
 * alert opt-in). The rejected step is caught by every caller (persist* log
 * and continue) and the chain's `.catch` keeps later writes flowing.
 */
const settingWriteChains = new Map<string, Promise<void>>();

export function updateFlowSetupSetting(
  shopId: string,
  mutate: (previous: CachedCoverage) => CachedCoverage,
): Promise<void> {
  const previous = settingWriteChains.get(shopId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const current = normalizeCoverage(
        (await getSetting(shopId, "klaviyoFlowSetup")) as Partial<CachedCoverage>,
      );
      await setSetting(shopId, "klaviyoFlowSetup", mutate(current), "system");
    });
  settingWriteChains.set(shopId, next);
  return next.finally(() => {
    if (settingWriteChains.get(shopId) === next) settingWriteChains.delete(shopId);
  });
}

function toCachedRows(rows: CoverageRow[]): CachedCoverageRow[] {
  return rows.map((r) => ({
    metric: r.metric,
    status: r.status,
    flowId: r.flowId,
    flowName: r.flowName,
    ours: r.ours,
    detail: r.detail,
  }));
}

async function persistCoverage(
  shopId: string,
  report: SetupReport,
  opts: { fromSetup: boolean },
): Promise<void> {
  try {
    await updateFlowSetupSetting(shopId, (previous) => ({
      ...previous,
      checkedAt: report.checkedAt,
      lastAttemptAt: report.checkedAt,
      setupRanAt: opts.fromSetup ? report.checkedAt : (previous.setupRanAt ?? null),
      rows: toCachedRows(report.rows),
    }));
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
    await updateFlowSetupSetting(shopId, (previous) => ({
      ...previous,
      lastAttemptAt: attemptAt,
    }));
  } catch (err) {
    console.error("[klaviyo-flows] attempt cache write failed", err);
  }
}

/**
 * Full checklist rows from the cache: every spec, joined by metric with the
 * cached verdict; specs never verified (a template added by an update, or a
 * store whose first verification is still running) are "unchecked" rather
 * than absent — the checklist always has one row per spec.
 */
export async function cachedCoverageRows(
  shopId: string,
  cached?: CachedCoverage,
): Promise<CoverageRow[]> {
  const cache = cached ?? (await readCachedCoverage(shopId));
  const byMetric = new Map(cache.rows.map((r) => [r.metric, r]));
  return flowSpecs().map((spec) => {
    const hit = byMetric.get(spec.metric);
    return {
      key: spec.key,
      metric: spec.metric,
      name: spec.name,
      templates: spec.templates,
      why: spec.why,
      status: (hit?.status as CoverageStatus | undefined) ?? "unchecked",
      flowId: hit?.flowId ?? "",
      flowName: hit?.flowName ?? "",
      ours: hit?.ours ?? false,
      detail: hit?.detail ?? "",
    };
  });
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
 *    model is folded into the row statuses) yet have no live flow;
 *  - skips the tick entirely while a verify/setup task is running (fresh
 *    persisted record): judging coverage mid-setup would raise a false
 *    alert on flows being created this minute and, on a slow re-read,
 *    persist a pre-setup snapshot over the run's own rows. The next tick
 *    sees the rows that run persisted.
 */
export async function staleOrMissingCoverage(
  shopId: string,
  now: Date,
): Promise<{ missing: string[]; checkedAt: string | null } | null> {
  const cached = await readCachedCoverage(shopId);
  if (!cached.setupRanAt) return null; // wizard never completed — never nag
  if (isFreshRunningTask(cached.task, now)) return null; // a run is refreshing it
  const lastTouch = [cached.checkedAt, cached.lastAttemptAt]
    .filter((v): v is string => typeof v === "string")
    .sort()
    .pop();
  const ageMs = lastTouch
    ? now.getTime() - new Date(lastTouch).getTime()
    : Number.POSITIVE_INFINITY;
  let rows: CachedCoverageRow[] = cached.rows;
  let checkedAt = cached.checkedAt;
  if (ageMs > 24 * 60 * 60 * 1000) {
    const report = await verifyFlowCoverage(shopId); // persists attempt/result
    if (!report.ok) return null; // can't verify (no key / scopes) — never guess
    rows = toCachedRows(report.rows);
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
