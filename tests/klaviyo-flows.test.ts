import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Guided Klaviyo flow setup (v1.18.0; index + runner reworked in v1.25.0,
 * app/lib/klaviyo/flows.server.ts).
 *
 * Pinned here:
 *  - SPEC COVERAGE: every EMAIL-channel, metric-carrying, non-critical,
 *    non-dormant template appears in exactly one flow spec; the three
 *    payment-failed notices share ONE flow (one metric); threeds_action,
 *    SMS, system mail and dormant templates are excluded (with reasons).
 *  - DEFINITION SHAPE: metric trigger by id, the cellexia_send="true"
 *    string trigger filter (the safety interlock), one send-email action
 *    with {{ event.content_subject }} subject, the template id, smart
 *    sending OFF, and templates created with editor_type "CODE".
 *  - INDEX (v1.25.0): coverage comes from ONE paginated
 *    GET /api/metrics/?include=flow-triggers request — NEVER a per-flow
 *    definition GET (the 3/s, 60/m endpoint that made every real store
 *    429 → fatal → empty checklist); archived flows are ignored; a flow
 *    under several metrics is merged; a 400 on the include parameter falls
 *    back to /api/metrics/ + per-metric flow-triggers (spec metrics only,
 *    paced); every request runs on the flows-capable revision.
 *  - RETRY: 429 waits Retry-After (capped 30 s, ≤ 4 attempts) and retries;
 *    GET 5xx/network backs off and retries; a POST 5xx is NEVER re-sent.
 *  - FAIL-CLOSED: an unreadable index is FATAL and keeps the previous
 *    cached rows — the checklist never blanks while a key is connected.
 *  - SETUP: creates ALL missing flows in one run, paced ≥ 4.1 s between
 *    flow POSTs; a 429 mid-run waits and continues; a sustained 429 or the
 *    8-minute run budget ends the run politely (rate_limited rows, the next
 *    click continues, no error rows, no draft double-POST); progress is
 *    reported per phase; the post-run verification resolves ambiguous
 *    POSTs.
 *  - SENDER AWARENESS, COVERAGE EVALUATION, SEED SAFETY, ALERT BUDGET —
 *    unchanged from v1.18.0.
 */

interface FakeFlow {
  id: string;
  name: string;
  status: string;
  archived?: boolean;
}
interface FakeMetric {
  id: string;
  name: string;
  flowIds: string[];
  /** Klaviyo `attributes.integration` (one metric per name+integration). */
  integration?: { name: string; category: string };
}
interface Scripted {
  match: (method: string, path: string) => boolean;
  response: Record<string, unknown>;
  /** Side effect executed when the scripted response is served. */
  effect?: (body: unknown) => void;
  /** Stays in the queue (default: consumed on first match). */
  sticky?: boolean;
}

const mocks = vi.hoisted(() => ({
  auth: { apiKey: "pk_test", revision: "2024-10-15", source: "settings" as const },
  metrics: [] as FakeMetric[],
  flows: new Map<string, FakeFlow>(),
  templatesByName: new Map<string, string>(),
  apiRequests: [] as Array<{
    method: string;
    path: string;
    body?: unknown;
    revision: string;
  }>,
  createdEvents: [] as Array<Record<string, unknown>>,
  settings: new Map<string, unknown>(),
  emailsSetting: { templates: {} as Record<string, unknown> },
  nextId: 0,
  failFlowPatch: false,
  rateLimitFlowCreates: false,
  includeSupported: true,
  paginateIndex: false,
  /** Seeds materialize immediately (the metric appears on the next list). */
  seedsMaterialize: true,
  scripted: [] as Scripted[],
  sleeps: [] as number[],
  clock: 0,
}));

vi.mock("~/lib/klaviyo/client.server", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("~/lib/klaviyo/client.server")
  >();
  const metricResource = (m: FakeMetric): Record<string, unknown> => ({
    type: "metric",
    id: m.id,
    attributes: {
      name: m.name,
      ...(m.integration ? { integration: { id: "int_1", ...m.integration } } : {}),
    },
    relationships: {
      "flow-triggers": { data: m.flowIds.map((id) => ({ type: "flow", id })) },
    },
  });
  const flowResource = (f: FakeFlow): Record<string, unknown> => ({
    type: "flow",
    id: f.id,
    attributes: {
      name: f.name,
      status: f.status,
      archived: f.archived ?? false,
      trigger_type: "Metric",
    },
  });
  return {
    ...original, // keep flowsAuth + FLOWS_API_REVISION real
    resolveKlaviyoAuth: vi.fn(async () => mocks.auth),
    createKlaviyoEvent: vi.fn(async (input: Record<string, unknown>) => {
      mocks.createdEvents.push(input);
      if (mocks.seedsMaterialize) {
        const name = input.eventName as string;
        if (!mocks.metrics.some((m) => m.name === name)) {
          mocks.metrics.push({ id: `SEEDED_${++mocks.nextId}`, name, flowIds: [] });
        }
      }
      return { ok: true, status: 202 };
    }),
    // No longer used by flows.server — a call would be a regression.
    klaviyoApiList: vi.fn(async () => {
      throw new Error("klaviyoApiList must not be used (bypasses the retry wrapper)");
    }),
    klaviyoApiRequest: vi.fn(
      async (
        auth: { revision: string },
        method: string,
        path: string,
        body?: unknown,
      ) => {
        mocks.apiRequests.push({ method, path, body, revision: auth.revision });
        const scriptedIndex = mocks.scripted.findIndex((s) => s.match(method, path));
        if (scriptedIndex >= 0) {
          const hit = mocks.scripted[scriptedIndex];
          if (!hit.sticky) mocks.scripted.splice(scriptedIndex, 1);
          hit.effect?.(body);
          return hit.response;
        }
        // Absolute pagination link → strip host.
        const p = path.replace(/^https?:\/\/[^/]+/, "");
        if (method === "GET" && p.startsWith("/api/metrics/?include=flow-triggers")) {
          if (!mocks.includeSupported) {
            return { ok: false, status: 400, error: "invalid include" };
          }
          const page2 = /page\[cursor\]=2/.test(p);
          const all = mocks.metrics;
          const slice = mocks.paginateIndex
            ? page2
              ? all.slice(Math.ceil(all.length / 2))
              : all.slice(0, Math.ceil(all.length / 2))
            : all;
          const flowIds = new Set(slice.flatMap((m) => m.flowIds));
          return {
            ok: true,
            status: 200,
            json: {
              data: slice.map(metricResource),
              included: [...flowIds]
                .map((id) => mocks.flows.get(id))
                .filter((f): f is FakeFlow => Boolean(f))
                .map(flowResource),
              links: {
                next:
                  mocks.paginateIndex && !page2
                    ? "https://a.klaviyo.com/api/metrics/?include=flow-triggers&page[cursor]=2"
                    : null,
              },
            },
          };
        }
        const triggers = p.match(/^\/api\/metrics\/([^/]+)\/flow-triggers\//);
        if (method === "GET" && triggers) {
          const metric = mocks.metrics.find((m) => m.id === triggers[1]);
          return {
            ok: true,
            status: 200,
            json: {
              data: (metric?.flowIds ?? [])
                .map((id) => mocks.flows.get(id))
                .filter((f): f is FakeFlow => Boolean(f))
                .map(flowResource),
            },
          };
        }
        if (method === "GET" && p.startsWith("/api/metrics/")) {
          return {
            ok: true,
            status: 200,
            json: { data: mocks.metrics.map(metricResource), links: { next: null } },
          };
        }
        if (method === "GET" && p.startsWith("/api/templates")) {
          const nameMatch = decodeURIComponent(p).match(/equals\(name,"(.+)"\)/);
          const id = nameMatch ? mocks.templatesByName.get(nameMatch[1]) : undefined;
          return {
            ok: true,
            status: 200,
            json: { data: id ? [{ id, attributes: {} }] : [], links: { next: null } },
          };
        }
        if (method === "GET" && /^\/api\/flows\/[^/]+\/\?/.test(p)) {
          // Per-flow definition GET — the v1.18.0 path this rework retired.
          return { ok: false, status: 500, error: "definition GETs are retired" };
        }
        if (method === "POST" && p.startsWith("/api/templates")) {
          const id = `tpl_${++mocks.nextId}`;
          const name = (body as { data: { attributes: { name: string } } }).data
            .attributes.name;
          mocks.templatesByName.set(name, id);
          return { ok: true, status: 201, json: { data: { id } } };
        }
        if (method === "POST" && p.startsWith("/api/flows")) {
          if (mocks.rateLimitFlowCreates) {
            return { ok: false, status: 429, error: "rate limited", retryAfterSeconds: 30 };
          }
          const id = createFakeFlow(body);
          return { ok: true, status: 201, json: { data: { id } } };
        }
        const patch = p.match(/^\/api\/flows\/([^/]+)\/$/);
        if (method === "PATCH" && patch) {
          if (mocks.failFlowPatch) return { ok: false, status: 500, error: "boom" };
          const flow = mocks.flows.get(patch[1]);
          if (flow) flow.status = "live";
          return { ok: true, status: 200, json: {} };
        }
        return { ok: true, status: 200, json: { data: [] } };
      },
    ),
    klaviyoErrorDetail: vi.fn(() => null),
  };
});
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string) => {
    if (key === "emails") return mocks.emailsSetting;
    return (
      mocks.settings.get(key) ?? {
        checkedAt: null,
        lastAttemptAt: null,
        setupRanAt: null,
        rows: [],
        task: null,
      }
    );
  }),
  setSetting: vi.fn(async (_shopId: string, key: string, value: unknown) => {
    mocks.settings.set(key, value);
  }),
}));
vi.mock("~/lib/notifications/mailer.server", () => ({
  resolveMailConfig: vi.fn(async () => ({
    provider: "smtp",
    source: "settings",
    from: "Cellexia <care@cellexia.com>",
    host: "smtp.example",
    port: 587,
    secure: false,
    user: null,
    pass: null,
  })),
}));

/** Registers a flow created through POST /api/flows/ (draft, triggered on the definition's metric). */
function createFakeFlow(body: unknown): string {
  const id = `flow_${++mocks.nextId}`;
  const attrs = (body as {
    data: {
      attributes: {
        name: string;
        definition: { triggers: Array<{ id: string }> };
      };
    };
  }).data.attributes;
  mocks.flows.set(id, { id, name: attrs.name, status: "draft" });
  const metricId = attrs.definition.triggers[0]?.id;
  const metric = mocks.metrics.find((m) => m.id === metricId);
  if (metric) metric.flowIds.push(id);
  return id;
}

import { FLOWS_API_REVISION } from "~/lib/klaviyo/client.server";
import {
  buildFlowDefinition,
  cachedCoverageRows,
  CELLEXIA_SEND_PROPERTY,
  effectiveDeliveryFor,
  evaluateCoverage,
  EXCLUDED_FROM_SETUP,
  flowSpecs,
  flowTemplateHtml,
  flowTemplateText,
  FLOW_TASK_STALE_MS,
  listMetricFlowIndex,
  listMetricsByName,
  runGuidedSetup,
  staleOrMissingCoverage,
  verifyFlowCoverage,
  type KlaviyoFlowInfo,
  type SetupProgress,
} from "~/lib/klaviyo/flows.server";
import { TEMPLATES, type TemplateKey } from "~/lib/notifications/templates.server";
import { EMAIL_CATALOG } from "~/lib/notifications/catalog.server";

/** Fake clock: sleeps are recorded and advance `now` instantly. */
const TIMING = {
  sleep: async (ms: number): Promise<void> => {
    mocks.sleeps.push(ms);
    mocks.clock += ms;
  },
  now: (): number => mocks.clock,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.metrics = [];
  mocks.flows = new Map();
  mocks.templatesByName = new Map();
  mocks.apiRequests = [];
  mocks.createdEvents = [];
  mocks.settings = new Map();
  mocks.emailsSetting = { templates: {} };
  mocks.nextId = 0;
  mocks.failFlowPatch = false;
  mocks.rateLimitFlowCreates = false;
  mocks.includeSupported = true;
  mocks.paginateIndex = false;
  mocks.seedsMaterialize = true;
  mocks.scripted = [];
  mocks.sleeps = [];
  mocks.clock = 0;
});

function addMetric(
  id: string,
  name: string,
  integration?: FakeMetric["integration"],
): FakeMetric {
  const metric: FakeMetric = { id, name, flowIds: [], integration };
  mocks.metrics.push(metric);
  return metric;
}

/** Registers a flow triggered by the given metric ids. */
function addFlow(input: {
  id: string;
  name: string;
  status: string;
  metricIds: string[];
  archived?: boolean;
}): void {
  mocks.flows.set(input.id, {
    id: input.id,
    name: input.name,
    status: input.status,
    archived: input.archived,
  });
  for (const metricId of input.metricIds) {
    const metric = mocks.metrics.find((m) => m.id === metricId);
    if (metric) metric.flowIds.push(input.id);
  }
}

/** Every spec metric registered as MET<i>. */
function addAllSpecMetrics(): void {
  for (const [i, s] of flowSpecs().entries()) addMetric(`MET${i}`, s.metric);
}

const flowPosts = () =>
  mocks.apiRequests.filter((r) => r.method === "POST" && r.path.includes("flows"));
const definitionGets = () =>
  mocks.apiRequests.filter(
    (r) => r.method === "GET" && /^\/api\/flows\/[^/]+\/\?/.test(r.path),
  );
const indexGets = () =>
  mocks.apiRequests.filter(
    (r) => r.method === "GET" && r.path.includes("include=flow-triggers"),
  );

describe("flow specs", () => {
  it("covers every eligible template exactly once; exclusions are deliberate and explained", () => {
    const specs = flowSpecs();
    const covered = new Set(specs.flatMap((s) => s.templates));
    const excludedKeys = new Set(EXCLUDED_FROM_SETUP.map((e) => e.template));
    for (const [key, def] of Object.entries(TEMPLATES) as Array<
      [TemplateKey, (typeof TEMPLATES)[TemplateKey]]
    >) {
      const eligible =
        def.channel === "EMAIL" &&
        def.klaviyoMetric !== "" &&
        !def.critical &&
        !EMAIL_CATALOG[key].dormant;
      expect(covered.has(key), key).toBe(eligible);
      if (!eligible && !EMAIL_CATALOG[key].dormant) {
        expect(excludedKeys.has(key), `${key} needs an exclusion reason`).toBe(true);
      }
    }
    for (const e of EXCLUDED_FROM_SETUP) {
      expect(e.reason.length).toBeGreaterThan(10);
    }
  });

  it("the three payment-failed notices ride ONE flow (one metric)", () => {
    const paymentSpecs = flowSpecs().filter(
      (s) => s.metric === "Cellexia Payment Failed",
    );
    expect(paymentSpecs).toHaveLength(1);
    expect(paymentSpecs[0].templates.sort()).toEqual([
      "payment_failed_1",
      "payment_failed_2",
      "payment_failed_3",
    ]);
  });

  it("every spec has a churn rationale and a Cellexia-prefixed name", () => {
    for (const spec of flowSpecs()) {
      expect(spec.why.length, spec.metric).toBeGreaterThan(10);
      expect(spec.name.startsWith("Cellexia — "), spec.metric).toBe(true);
    }
  });

  it("includes the eight confirmation metrics", () => {
    const metrics = new Set(flowSpecs().map((s) => s.metric));
    for (const metric of [
      "Cellexia Order Skipped",
      "Cellexia Order Unskipped",
      "Cellexia Order Delayed",
      "Cellexia Subscription Paused",
      "Cellexia Subscription Resumed",
      "Cellexia Product Swapped",
      "Cellexia Frequency Changed",
      "Cellexia Subscription Cancelled",
    ]) {
      expect(metrics.has(metric), metric).toBe(true);
    }
  });
});

describe("effective delivery (sender model)", () => {
  const upcoming = flowSpecs().find((s) => s.metric === "Cellexia Upcoming Order")!;
  const payment = flowSpecs().find((s) => s.metric === "Cellexia Payment Failed")!;

  it("defaults to klaviyo; sender app → app; disabled → off", () => {
    expect(effectiveDeliveryFor(upcoming, {})).toBe("klaviyo");
    expect(
      effectiveDeliveryFor(upcoming, { upcoming_order: { sender: "app" } }),
    ).toBe("app");
    expect(
      effectiveDeliveryFor(upcoming, { upcoming_order: { enabled: false } }),
    ).toBe("off");
  });

  it("a shared metric needs a flow while ANY of its templates rides Klaviyo", () => {
    expect(
      effectiveDeliveryFor(payment, {
        payment_failed_1: { sender: "app" },
        payment_failed_2: { sender: "app" },
      }),
    ).toBe("klaviyo"); // payment_failed_3 still rides Klaviyo
    expect(
      effectiveDeliveryFor(payment, {
        payment_failed_1: { sender: "app" },
        payment_failed_2: { sender: "app" },
        payment_failed_3: { sender: "app" },
      }),
    ).toBe("app");
  });
});

describe("flow definition", () => {
  const definition = buildFlowDefinition({
    metricId: "MET1",
    templateId: "TPL1",
    flowName: "Cellexia — Upcoming Order",
    fromEmail: "care@cellexia.com",
    fromLabel: "Cellexia",
    messageStatus: "live",
  }) as {
    triggers: Array<{
      type: string;
      id: string;
      trigger_filter: {
        condition_groups: Array<{
          conditions: Array<{
            type: string;
            metric_id: string;
            field: string;
            filter: { type: string; operator: string; value: string };
          }>;
        }>;
      };
    }>;
    entry_action_id: string;
    actions: Array<{
      temporary_id: string;
      type: string;
      data: { message: Record<string, unknown>; status: string };
    }>;
  };

  it("triggers on the metric id, gated on cellexia_send string-equals 'true'", () => {
    expect(definition.triggers).toHaveLength(1);
    const trigger = definition.triggers[0];
    expect(trigger.type).toBe("metric");
    expect(trigger.id).toBe("MET1");
    const condition = trigger.trigger_filter.condition_groups[0].conditions[0];
    expect(condition.type).toBe("metric-property");
    expect(condition.metric_id).toBe("MET1");
    expect(condition.field).toBe(CELLEXIA_SEND_PROPERTY);
    expect(condition.filter).toEqual({
      type: "string",
      operator: "equals",
      value: "true",
    });
  });

  it("one send-email action: event subject, the template, smart sending OFF", () => {
    expect(definition.entry_action_id).toBe(definition.actions[0].temporary_id);
    const action = definition.actions[0];
    expect(action.type).toBe("send-email");
    expect(action.data.message.subject_line).toBe("{{ event.content_subject }}");
    expect(action.data.message.template_id).toBe("TPL1");
    expect(action.data.message.smart_sending_enabled).toBe(false);
    expect(action.data.message.add_tracking_params).toBe(false);
    expect(action.data.message.from_email).toBe("care@cellexia.com");
    expect(action.data.status).toBe("live");
  });
});

describe("flow template", () => {
  it("renders the app's email and carries Klaviyo's compliance footer", () => {
    const html = flowTemplateHtml();
    expect(html).toContain("{{ event.content_html }}");
    expect(html).toContain('href="{% unsubscribe_link %}"');
    expect(html).toContain("{{ organization.name }}");
    expect(html).toContain("{{ organization.full_address }}");
    const text = flowTemplateText();
    expect(text).toContain("{{ event.content_text }}");
    expect(text).toContain("{% unsubscribe_link %}");
  });
});

describe("metric→flow index (v1.25.0)", () => {
  it("all metrics/flows/templates requests run on the flows-capable revision, even with an older events revision", async () => {
    mocks.auth = { ...mocks.auth, revision: "2024-10-15" };
    addAllSpecMetrics();
    await listMetricFlowIndex(mocks.auth, TIMING);
    await runGuidedSetup("shop_1", "admin@example.com", TIMING);
    expect(mocks.apiRequests.length).toBeGreaterThan(5);
    for (const request of mocks.apiRequests) {
      expect(request.revision >= FLOWS_API_REVISION, request.path).toBe(true);
    }
  });

  it("reads coverage from ONE metrics?include=flow-triggers request — never a per-flow definition GET", async () => {
    addMetric("MET1", "Cellexia Upcoming Order");
    addMetric("MET2", "Cellexia Order Confirmed");
    addMetric("MET3", "Placed Order"); // not ours — but its flows must not cost requests
    addFlow({ id: "f_ours", name: "Cellexia — Upcoming Order", status: "live", metricIds: ["MET1"] });
    addFlow({ id: "f_shared", name: "Both", status: "draft", metricIds: ["MET1", "MET2"] });
    addFlow({ id: "f_arch", name: "Old", status: "live", metricIds: ["MET2"], archived: true });
    for (let i = 0; i < 80; i += 1) {
      addFlow({ id: `f_other_${i}`, name: `Merchant ${i}`, status: "live", metricIds: ["MET3"] });
    }
    const index = await listMetricFlowIndex(mocks.auth, TIMING);
    expect(index.ok).toBe(true);
    expect(index.source).toBe("include");
    expect(indexGets()).toHaveLength(1);
    expect(definitionGets()).toHaveLength(0);
    expect(mocks.apiRequests).toHaveLength(1);
    expect(index.byName.get("Cellexia Upcoming Order")).toBe("MET1");
    const shared = index.flows.find((f) => f.id === "f_shared")!;
    expect(shared.triggerMetricIds.sort()).toEqual(["MET1", "MET2"]);
    expect(shared.status).toBe("draft");
    expect(index.flows.some((f) => f.id === "f_arch")).toBe(false); // archived ignored
    expect(index.flows.filter((f) => f.id.startsWith("f_other")).length).toBe(80);
  });

  it("follows links.next pagination and merges the pages", async () => {
    addAllSpecMetrics();
    addFlow({ id: "f1", name: "X", status: "live", metricIds: ["MET0"] });
    addFlow({ id: "f2", name: "Y", status: "live", metricIds: [`MET${flowSpecs().length - 1}`] });
    mocks.paginateIndex = true;
    const index = await listMetricFlowIndex(mocks.auth, TIMING);
    expect(index.ok).toBe(true);
    expect(indexGets()).toHaveLength(2);
    expect(index.byName.size).toBe(flowSpecs().length);
    expect(index.flows.map((f) => f.id).sort()).toEqual(["f1", "f2"]);
  });

  it("falls back to /api/metrics/ + per-metric flow-triggers when the include parameter is rejected with 400 — spec metrics only, paced", async () => {
    mocks.includeSupported = false;
    addAllSpecMetrics();
    addMetric("OTHER", "Placed Order");
    addFlow({ id: "f1", name: "Mine", status: "live", metricIds: ["MET0"] });
    addFlow({ id: "f_arch", name: "Old", status: "live", metricIds: ["MET1"], archived: true });
    const index = await listMetricFlowIndex(mocks.auth, TIMING);
    expect(index.ok).toBe(true);
    expect(index.source).toBe("per_metric");
    expect(definitionGets()).toHaveLength(0);
    const triggerGets = mocks.apiRequests.filter((r) => r.path.includes("/flow-triggers/"));
    expect(triggerGets).toHaveLength(flowSpecs().length);
    expect(triggerGets.some((r) => r.path.includes("/OTHER/"))).toBe(false);
    expect(mocks.sleeps.filter((ms) => ms === 120)).toHaveLength(flowSpecs().length - 1);
    expect(index.flows.find((f) => f.id === "f1")?.triggerMetricIds).toEqual(["MET0"]);
    expect(index.flows.some((f) => f.id === "f_arch")).toBe(false);
  });

  it("a 429 on the read waits Retry-After (injected sleep) and retries", async () => {
    addAllSpecMetrics();
    mocks.scripted.push({
      match: (m, p) => m === "GET" && p.includes("include=flow-triggers"),
      response: { ok: false, status: 429, error: "slow down", retryAfterSeconds: 3 },
    });
    const index = await listMetricFlowIndex(mocks.auth, TIMING);
    expect(index.ok).toBe(true);
    expect(indexGets()).toHaveLength(2);
    expect(mocks.sleeps).toEqual([3000]);
  });

  it("caps Retry-After at 30 s and gives up after 4 attempts", async () => {
    addAllSpecMetrics();
    for (let i = 0; i < 6; i += 1) {
      mocks.scripted.push({
        match: (m, p) => m === "GET" && p.includes("include=flow-triggers"),
        response: { ok: false, status: 429, error: "slow down", retryAfterSeconds: 120 },
      });
    }
    const index = await listMetricFlowIndex(mocks.auth, TIMING);
    expect(index.ok).toBe(false);
    expect(index.status).toBe(429);
    expect(indexGets()).toHaveLength(4);
    expect(mocks.sleeps).toEqual([30_000, 30_000, 30_000]);
  });

  it("a 5xx on a GET backs off and retries; a 5xx on a flow POST is never re-sent", async () => {
    addAllSpecMetrics();
    mocks.scripted.push({
      match: (m, p) => m === "GET" && p.includes("include=flow-triggers"),
      response: { ok: false, status: 503, error: "hiccup" },
    });
    // The FIRST flow POST fails 5xx WITHOUT creating anything.
    mocks.scripted.push({
      match: (m, p) => m === "POST" && p.startsWith("/api/flows"),
      response: { ok: false, status: 502, error: "bad gateway" },
    });
    const report = await runGuidedSetup("shop_1", "admin@example.com", TIMING);
    expect(report.ok).toBe(true);
    expect(mocks.sleeps[0]).toBe(2000); // GET backoff
    const specs = flowSpecs();
    // n specs → n POST attempts: the failed one was NOT retried (n, not n+1).
    expect(flowPosts()).toHaveLength(specs.length);
    const errored = report.rows.filter((r) => r.status === "error");
    expect(errored).toHaveLength(1);
    expect(errored[0].detail).toContain("did not accept the flow");
    expect(report.rows.filter((r) => r.status === "live")).toHaveLength(specs.length - 1);
  });

  it("an unreadable index is FATAL and keeps the previous cached rows — never an empty checklist", async () => {
    mocks.settings.set("klaviyoFlowSetup", {
      checkedAt: "2026-08-01T00:00:00.000Z",
      lastAttemptAt: "2026-08-01T00:00:00.000Z",
      setupRanAt: "2026-08-01T00:00:00.000Z",
      rows: [
        {
          metric: "Cellexia Upcoming Order",
          status: "live",
          flowId: "f",
          flowName: "Cellexia — Upcoming Order",
          ours: true,
          detail: "",
        },
      ],
      task: null,
    });
    for (let i = 0; i < 6; i += 1) {
      mocks.scripted.push({
        match: (m, p) => m === "GET" && p.includes("include=flow-triggers"),
        response: { ok: false, status: 500, error: "down" },
      });
    }
    const report = await verifyFlowCoverage("shop_1", TIMING);
    expect(report.ok).toBe(false);
    expect(report.fatal).toContain("Could not read");
    expect(report.rows).toHaveLength(flowSpecs().length);
    const upcoming = report.rows.find((r) => r.metric === "Cellexia Upcoming Order")!;
    expect(upcoming.status).toBe("live");
    expect(upcoming.flowName).toBe("Cellexia — Upcoming Order");
    expect(report.rows.filter((r) => r.status === "unchecked")).toHaveLength(
      flowSpecs().length - 1,
    );
    const cached = mocks.settings.get("klaviyoFlowSetup") as {
      checkedAt: string;
      lastAttemptAt: string;
      rows: unknown[];
    };
    expect(cached.checkedAt).toBe("2026-08-01T00:00:00.000Z"); // last GOOD verdict kept
    expect(cached.lastAttemptAt > "2026-08-01T00:00:00.000Z").toBe(true);
    expect(cached.rows).toHaveLength(1);
  });

  it("a flow referenced by flow-triggers but absent from `included` is kept as not-live — never 'missing', never a twin POST, never labelled ours", async () => {
    const specs = flowSpecs();
    addAllSpecMetrics();
    for (const [i] of specs.entries()) {
      if (i === 0) continue;
      addFlow({ id: `f_live_${i}`, name: `Merchant ${i}`, status: "live", metricIds: [`MET${i}`] });
    }
    // Referenced in relationships["flow-triggers"], but no mocks.flows entry
    // → the mock omits it from `included` (an unreadable flow).
    mocks.metrics[0].flowIds.push("f_ghost");
    const index = await listMetricFlowIndex(mocks.auth, TIMING);
    expect(index.ok).toBe(true);
    const ghost = index.flows.find((f) => f.id === "f_ghost");
    expect(ghost).toBeDefined();
    expect(ghost!.status).not.toBe("live");
    expect(ghost!.triggerMetricIds).toEqual(["MET0"]);
    const rows = evaluateCoverage(specs, index.byName, index.flows);
    expect(rows[0].status).toBe("not_live");
    expect(rows[0].ours).toBe(false);
    expect(rows[0].flowId).toBe("f_ghost");
    // The unreadable flow must never read as "no flow here": zero creations.
    const report = await runGuidedSetup("shop_1", "admin@example.com", TIMING);
    expect(report.ok).toBe(true);
    expect(flowPosts()).toHaveLength(0);
    expect(report.rows[0].status).toBe("not_live");
    expect(report.rows[0].ours).toBe(false);
  });

  it("same-named metrics under two integrations: the API-integration one (where the app's events land) wins in EITHER listing order — never last-writer-wins", async () => {
    // API metric FIRST, a Zapier twin second (last-writer-wins would pick Zapier).
    addMetric("API_OC", "Cellexia Order Confirmed", { name: "API", category: "API" });
    addMetric("ZAP_OC", "Cellexia Order Confirmed", { name: "Zapier", category: "Zapier" });
    addFlow({ id: "f_real", name: "Cellexia — Order Confirmed", status: "live", metricIds: ["API_OC"] });
    let index = await listMetricFlowIndex(mocks.auth, TIMING);
    expect(index.byName.get("Cellexia Order Confirmed")).toBe("API_OC");
    let rows = evaluateCoverage(flowSpecs(), index.byName, index.flows);
    expect(rows.find((r) => r.metric === "Cellexia Order Confirmed")?.status).toBe("live");

    // Reversed order: Zapier first, API second — still the API id.
    mocks.metrics = [];
    mocks.apiRequests = [];
    addMetric("ZAP_OC", "Cellexia Order Confirmed", { name: "Zapier", category: "Zapier" });
    addMetric("API_OC", "Cellexia Order Confirmed", { name: "API", category: "API" });
    addFlow({ id: "f_real", name: "Cellexia — Order Confirmed", status: "live", metricIds: ["API_OC"] });
    index = await listMetricFlowIndex(mocks.auth, TIMING);
    expect(index.byName.get("Cellexia Order Confirmed")).toBe("API_OC");
    rows = evaluateCoverage(flowSpecs(), index.byName, index.flows);
    expect(rows.find((r) => r.metric === "Cellexia Order Confirmed")?.status).toBe("live");

    // Same rule on the fallback listing (per-metric path) and the seed poll's list.
    mocks.includeSupported = false;
    index = await listMetricFlowIndex(mocks.auth, TIMING);
    expect(index.source).toBe("per_metric");
    expect(index.byName.get("Cellexia Order Confirmed")).toBe("API_OC");
    const plain = await listMetricsByName(mocks.auth, TIMING);
    expect(plain.byName.get("Cellexia Order Confirmed")).toBe("API_OC");

    // No API-integration twin at all → the FIRST listed is kept (deterministic).
    mocks.metrics = [];
    addMetric("A1", "Cellexia Order Confirmed", { name: "Zapier", category: "Zapier" });
    addMetric("A2", "Cellexia Order Confirmed", { name: "Segment", category: "Segment" });
    mocks.includeSupported = true;
    index = await listMetricFlowIndex(mocks.auth, TIMING);
    expect(index.byName.get("Cellexia Order Confirmed")).toBe("A1");
  });

  it("guided setup builds a new flow's trigger on the API-integration metric, not on a same-named twin", async () => {
    const specs = flowSpecs();
    addAllSpecMetrics(); // MET<i>, no integration attribute
    // Every metric covered except Order Confirmed, which has a Zapier twin
    // listed AFTER the app's own (API) metric.
    const oc = specs.findIndex((s) => s.metric === "Cellexia Order Confirmed");
    for (const [i] of specs.entries()) {
      if (i === oc) continue;
      addFlow({ id: `f_${i}`, name: `Mine ${i}`, status: "live", metricIds: [`MET${i}`] });
    }
    mocks.metrics[oc].integration = { name: "API", category: "API" };
    addMetric("ZAP_OC", "Cellexia Order Confirmed", { name: "Zapier", category: "Zapier" });
    const report = await runGuidedSetup("shop_1", "admin@example.com", TIMING);
    expect(report.ok).toBe(true);
    expect(flowPosts()).toHaveLength(1);
    const body = flowPosts()[0].body as {
      data: { attributes: { definition: { triggers: Array<{ id: string }> } } };
    };
    expect(body.data.attributes.definition.triggers[0].id).toBe(`MET${oc}`);
    expect(report.rows[oc].status).toBe("live");
  });

  it("cachedCoverageRows joins the cache with the specs — specs without a verdict are 'unchecked'", async () => {
    mocks.settings.set("klaviyoFlowSetup", {
      checkedAt: null,
      lastAttemptAt: null,
      setupRanAt: null,
      rows: [
        { metric: "Cellexia Order Confirmed", status: "missing", flowId: "", flowName: "", ours: false, detail: "why" },
      ],
    });
    const rows = await cachedCoverageRows("shop_1");
    expect(rows).toHaveLength(flowSpecs().length);
    const confirmed = rows.find((r) => r.metric === "Cellexia Order Confirmed")!;
    expect(confirmed.status).toBe("missing");
    expect(confirmed.detail).toBe("why");
    expect(confirmed.name).toBe("Cellexia — Order Confirmed");
    expect(rows.filter((r) => r.status === "unchecked")).toHaveLength(flowSpecs().length - 1);
  });
});

describe("coverage evaluation", () => {
  const specs = flowSpecs();
  const upcoming = specs.find((s) => s.metric === "Cellexia Upcoming Order")!;
  const metricByName = new Map([["Cellexia Upcoming Order", "MET1"]]);

  const flow = (over: Partial<KlaviyoFlowInfo>): KlaviyoFlowInfo => ({
    id: "flow_1",
    name: "Cellexia — Upcoming Order",
    status: "live",
    triggerMetricIds: ["MET1"],
    ...over,
  });

  it("a live flow of OURS is green and marked ours", () => {
    const rows = evaluateCoverage([upcoming], metricByName, [flow({})]);
    expect(rows[0].status).toBe("live");
    expect(rows[0].ours).toBe(true);
  });

  it("the merchant's own live flow counts — and is never treated as ours", () => {
    const rows = evaluateCoverage([upcoming], metricByName, [
      flow({ name: "My upcoming order reminder" }),
    ]);
    expect(rows[0].status).toBe("live");
    expect(rows[0].ours).toBe(false);
    expect(rows[0].flowName).toBe("My upcoming order reminder");
  });

  it("a draft flow is 'not_live'; the fix-it hint differs for ours vs merchant flows", () => {
    const ours = evaluateCoverage([upcoming], metricByName, [
      flow({ status: "draft" }),
    ])[0];
    expect(ours.status).toBe("not_live");
    expect(ours.detail).toContain("re-run setup");
    const theirs = evaluateCoverage([upcoming], metricByName, [
      flow({ status: "draft", name: "My reminder" }),
    ])[0];
    expect(theirs.detail).not.toContain("re-run setup");
    expect(evaluateCoverage([upcoming], metricByName, [])[0].status).toBe("missing");
  });

  it("an unregistered metric is 'pending_metric', never an error", () => {
    expect(evaluateCoverage([upcoming], new Map(), [])[0].status).toBe(
      "pending_metric",
    );
  });

  it("app-delivered and disabled templates report honestly — never 'customers receive nothing'", () => {
    const app = evaluateCoverage([upcoming], metricByName, [], {
      upcoming_order: { sender: "app" },
    })[0];
    expect(app.status).toBe("app_delivers");
    const off = evaluateCoverage([upcoming], metricByName, [], {
      upcoming_order: { enabled: false },
    })[0];
    expect(off.status).toBe("off");
  });
});

describe("guided setup", () => {
  it("seeds missing metrics with cellexia_send 'false' — a seed can never email anyone", async () => {
    mocks.seedsMaterialize = false; // Klaviyo lagging: rows stay pending
    const report = await runGuidedSetup("shop_1", "admin@example.com", TIMING);
    expect(report.ok).toBe(true);
    expect(report.seeded.length).toBe(flowSpecs().length);
    for (const event of mocks.createdEvents) {
      const props = event.properties as Record<string, unknown>;
      expect(props[CELLEXIA_SEND_PROPERTY]).toBe("false");
      expect(props.setup_seed).toBe(true);
      expect(event.email).toBe("admin@example.com");
    }
    expect(flowPosts()).toHaveLength(0);
    for (const row of report.rows) {
      expect(row.status).toBe("pending_metric");
    }
    // The seed poll waited its five rounds without hanging the caller.
    expect(mocks.sleeps.filter((ms) => ms === 3000)).toHaveLength(5);
  });

  it("creates template (editor_type CODE) + flow + sets it live for an uncovered metric — covered metrics untouched", async () => {
    const specs = flowSpecs();
    addAllSpecMetrics();
    for (const [i, s] of specs.entries()) {
      if (s.metric === "Cellexia Upcoming Order") continue;
      addFlow({
        id: `existing_${i}`,
        name: `My ${s.metric} flow`,
        status: "live",
        metricIds: [`MET${i}`],
      });
    }

    const report = await runGuidedSetup("shop_1", "admin@example.com", TIMING);
    expect(report.ok).toBe(true);
    expect(report.seeded).toHaveLength(0);

    expect(flowPosts()).toHaveLength(1); // ONLY the uncovered metric
    const body = flowPosts()[0].body as {
      data: { attributes: { name: string } };
    };
    expect(body.data.attributes.name).toBe("Cellexia — Upcoming Order");

    const templatePosts = mocks.apiRequests.filter(
      (r) => r.method === "POST" && r.path.includes("templates"),
    );
    expect(templatePosts).toHaveLength(1);
    expect(
      (
        templatePosts[0].body as {
          data: { attributes: { editor_type: string } };
        }
      ).data.attributes.editor_type,
    ).toBe("CODE");

    const patches = mocks.apiRequests.filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(definitionGets()).toHaveLength(0);

    const upcomingRow = report.rows.find(
      (r) => r.metric === "Cellexia Upcoming Order",
    )!;
    expect(upcomingRow.status).toBe("live");
    expect(upcomingRow.ours).toBe(true);
    // Merchant flows stay merchant flows.
    const merchantRow = report.rows.find((r) => r.metric === "Cellexia Order Skipped")!;
    expect(merchantRow.status).toBe("live");
    expect(merchantRow.ours).toBe(false);

    const cached = mocks.settings.get("klaviyoFlowSetup") as {
      rows: Array<{ metric: string; status: string; detail: string }>;
      setupRanAt: string | null;
    };
    expect(cached.rows.length).toBe(specs.length);
    expect(cached.setupRanAt).toBeTruthy();
    expect(cached.rows.every((r) => typeof r.detail === "string")).toBe(true);
  });

  it("creates ALL missing flows in one run — no per-run cap — paced ≥ 4.1 s between flow POSTs, reporting progress per phase", async () => {
    const specs = flowSpecs();
    addAllSpecMetrics();
    const progress: SetupProgress[] = [];
    const report = await runGuidedSetup("shop_1", "admin@example.com", {
      ...TIMING,
      onProgress: (p) => progress.push(p),
    });
    expect(report.ok).toBe(true);
    expect(flowPosts()).toHaveLength(specs.length);
    expect(report.rows.every((r) => r.status === "live" && r.ours)).toBe(true);
    expect(mocks.sleeps.filter((ms) => ms === 4100)).toHaveLength(specs.length - 1);
    expect(definitionGets()).toHaveLength(0);
    // Reads: one index read before, one verification read after — that's it.
    expect(indexGets()).toHaveLength(2);

    const steps = new Set(progress.map((p) => p.step));
    for (const step of ["reading", "creating", "verifying", "done"]) {
      expect(steps.has(step as SetupProgress["step"]), step).toBe(true);
    }
    const creating = progress.filter((p) => p.step === "creating");
    expect(creating[0].total).toBe(specs.length);
    expect(creating[0].done).toBe(0);
    expect(creating[0].message).toContain(`Creating flow 1 of ${specs.length}`);
    expect(creating[0].message).toContain(specs[0].name);
    expect(creating.at(-1)!.done).toBe(specs.length - 1);
    // Template lookups reuse by name on a re-run: no second template POST.
    mocks.apiRequests = [];
    await runGuidedSetup("shop_1", "admin@example.com", TIMING);
    expect(flowPosts()).toHaveLength(0);
    expect(
      mocks.apiRequests.filter((r) => r.method === "POST" && r.path.includes("templates")),
    ).toHaveLength(0);
  });

  it("seeding → waiting → creating happen in ONE run when Klaviyo registers the seeds", async () => {
    const progress: SetupProgress[] = [];
    const report = await runGuidedSetup("shop_1", "admin@example.com", {
      ...TIMING,
      onProgress: (p) => progress.push(p),
    });
    expect(report.seeded.length).toBe(flowSpecs().length);
    const steps = progress.map((p) => p.step);
    expect(steps).toContain("seeding");
    expect(steps).toContain("waiting_metrics");
    expect(steps).toContain("creating");
    expect(report.rows.every((r) => r.status === "live")).toBe(true);
  });

  it("skips creating flows for app-delivered metrics (an inert flow helps nobody)", async () => {
    const specs = flowSpecs();
    addAllSpecMetrics();
    mocks.emailsSetting = {
      templates: Object.fromEntries(
        specs.flatMap((s) => s.templates.map((t) => [t, { sender: "app" }])),
      ),
    };
    const report = await runGuidedSetup("shop_1", "admin@example.com", TIMING);
    expect(report.ok).toBe(true);
    expect(flowPosts()).toHaveLength(0);
    for (const row of report.rows) expect(row.status).toBe("app_delivers");
  });

  it("a 429 mid-run waits Retry-After and CONTINUES — every flow still gets created", async () => {
    const specs = flowSpecs();
    addAllSpecMetrics();
    let seen = 0;
    mocks.scripted.push({
      // The third flow POST is throttled once.
      match: (m, p) => m === "POST" && p.startsWith("/api/flows") && ++seen === 3,
      response: { ok: false, status: 429, error: "rate limited", retryAfterSeconds: 12 },
    });
    const report = await runGuidedSetup("shop_1", "admin@example.com", TIMING);
    expect(report.ok).toBe(true);
    expect(flowPosts()).toHaveLength(specs.length + 1); // one retried POST
    expect(mocks.sleeps).toContain(12_000);
    expect(report.rows.every((r) => r.status === "live")).toBe(true);
    expect(report.rows.some((r) => r.status === "rate_limited")).toBe(false);
  });

  it("a SUSTAINED 429 ends the run politely: rate_limited rows, no error rows, no draft double-POST, the next click continues", async () => {
    addAllSpecMetrics();
    mocks.rateLimitFlowCreates = true;
    const report = await runGuidedSetup("shop_1", "admin@example.com", TIMING);
    expect(report.ok).toBe(true);
    // 4 attempts on the first row (Retry-After honored, capped), then stop.
    expect(flowPosts()).toHaveLength(4);
    expect(
      flowPosts().every(
        (r) =>
          (r.body as { data: { attributes: { definition: { actions: Array<{ data: { status: string } }> } } } })
            .data.attributes.definition.actions[0].data.status === "live",
      ),
    ).toBe(true); // never the draft fallback on a 429
    expect(mocks.sleeps.filter((ms) => ms === 30_000)).toHaveLength(3);
    expect(report.rows.every((r) => r.status === "rate_limited")).toBe(true);
    expect(report.rows[0].detail).toMatch(/next .*click continues/i);
    expect(report.rows.some((r) => r.status === "error")).toBe(false);

    // Klaviyo recovers → the next click picks up where this one stopped.
    mocks.rateLimitFlowCreates = false;
    mocks.apiRequests = [];
    const again = await runGuidedSetup("shop_1", "admin@example.com", TIMING);
    expect(flowPosts()).toHaveLength(flowSpecs().length);
    expect(again.rows.every((r) => r.status === "live")).toBe(true);
  });

  it("the 8-minute run budget: leftover rows report rate_limited and the next click continues without duplicating", async () => {
    const specs = flowSpecs();
    addAllSpecMetrics();
    // Every flow POST is throttled twice (Retry-After 30 s) before it
    // succeeds — ~64 s per flow — so the budget runs out around the eighth
    // flow. Scripted entries are consumed in order: two 429s, then the
    // default handler creates the flow, and so on. Note the wrapper's own
    // per-call ceiling shrinks to the remaining run budget near the end.
    let attemptsOnCurrent = 0;
    mocks.scripted.push({
      sticky: true,
      match: (m, p) => {
        if (m !== "POST" || !p.startsWith("/api/flows")) return false;
        attemptsOnCurrent += 1;
        if (attemptsOnCurrent <= 2) return true;
        attemptsOnCurrent = 0; // this attempt succeeds; re-arm for the next flow
        return false;
      },
      response: { ok: false, status: 429, error: "rate limited", retryAfterSeconds: 30 },
    });
    const report = await runGuidedSetup("shop_1", "admin@example.com", TIMING);
    expect(report.ok).toBe(true);
    const live = report.rows.filter((r) => r.status === "live");
    const limited = report.rows.filter((r) => r.status === "rate_limited");
    expect(live.length).toBeGreaterThanOrEqual(5);
    expect(live.length).toBeLessThan(specs.length);
    expect(live.length + limited.length).toBe(specs.length);
    expect(report.rows.some((r) => r.status === "error")).toBe(false);
    expect(mocks.clock).toBeGreaterThan(8 * 60_000 - 60_000);

    // Next click: no throttling anymore → the rest gets created, nothing twice.
    mocks.scripted = [];
    mocks.apiRequests = [];
    const again = await runGuidedSetup("shop_1", "admin@example.com", TIMING);
    expect(again.rows.every((r) => r.status === "live")).toBe(true);
    const names = flowPosts().map(
      (r) => (r.body as { data: { attributes: { name: string } } }).data.attributes.name,
    );
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(limited.length);
    expect(mocks.flows.size).toBe(specs.length); // one flow per spec, ever
  });

  it("post-run verification resolves an ambiguous POST: a 5xx after Klaviyo created the flow shows the flow, not an error", async () => {
    addAllSpecMetrics();
    mocks.scripted.push({
      match: (m, p) => m === "POST" && p.startsWith("/api/flows"),
      response: { ok: false, status: 504, error: "gateway timeout" },
      effect: (body) => {
        createFakeFlow(body); // Klaviyo DID create it before timing out
      },
    });
    const report = await runGuidedSetup("shop_1", "admin@example.com", TIMING);
    const first = report.rows.find((r) => r.name === flowSpecs()[0].name)!;
    expect(first.status).toBe("not_live"); // created (draft), seen by the verify read
    expect(first.ours).toBe(true);
    expect(first.flowId).toBeTruthy();
    expect(report.rows.some((r) => r.status === "error")).toBe(false);
    // And the next run sets that draft live instead of creating a twin.
    mocks.apiRequests = [];
    const again = await runGuidedSetup("shop_1", "admin@example.com", TIMING);
    expect(flowPosts()).toHaveLength(0);
    expect(again.rows.every((r) => r.status === "live")).toBe(true);
  });

  it("re-running sets OUR draft flows live ('click until green'), never the merchant's", async () => {
    const specs = flowSpecs();
    addAllSpecMetrics();
    for (const [i, s] of specs.entries()) {
      addFlow({
        id: `f_${i}`,
        name:
          s.metric === "Cellexia Upcoming Order"
            ? s.name // ours, draft
            : `My ${s.metric} flow`, // merchant's, draft
        status: "draft",
        metricIds: [`MET${i}`],
      });
    }
    const report = await runGuidedSetup("shop_1", "admin@example.com", TIMING);
    const patches = mocks.apiRequests.filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(1); // only OUR draft got the set-live retry
    expect(flowPosts()).toHaveLength(0);
    const upcomingRow = report.rows.find(
      (r) => r.metric === "Cellexia Upcoming Order",
    )!;
    expect(upcomingRow.status).toBe("live");
    const merchantRow = report.rows.find(
      (r) => r.metric === "Cellexia Order Skipped",
    )!;
    expect(merchantRow.status).toBe("not_live");
    expect(merchantRow.ours).toBe(false);
  });

  it("two runGuidedSetup calls in flight for the same shop: the second returns the 'already running in another tab' fatal with zero extra POSTs; the guard is released afterwards", async () => {
    const specs = flowSpecs();
    addAllSpecMetrics();
    // A yielding sleep so the first run is genuinely mid-flight when the
    // second one starts (the fake TIMING sleep never yields).
    const yielding = {
      sleep: async (ms: number): Promise<void> => {
        mocks.clock += ms;
        await new Promise((r) => setTimeout(r, 0));
      },
      now: (): number => mocks.clock,
    };
    const [first, second] = await Promise.all([
      runGuidedSetup("shop_1", "admin@example.com", yielding),
      runGuidedSetup("shop_1", "admin@example.com", yielding),
    ]);
    expect(first.ok).toBe(true);
    expect(first.fatal).toBeUndefined();
    expect(second.ok).toBe(false);
    expect(second.fatal).toMatch(/already running in another tab/);
    expect(second.rows).toHaveLength(specs.length); // full row list, never empty
    expect(flowPosts()).toHaveLength(specs.length); // exactly one run's worth
    // Released in finally: a fresh run is allowed again (nothing left to create).
    mocks.apiRequests = [];
    const third = await runGuidedSetup("shop_1", "admin@example.com", TIMING);
    expect(third.fatal).toBeUndefined();
    expect(flowPosts()).toHaveLength(0);
  });

  it("reports a friendly fatal when no key is configured — with the full row list, not an empty table", async () => {
    const client = await import("~/lib/klaviyo/client.server");
    (client.resolveKlaviyoAuth as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      apiKey: null,
      revision: "2024-10-15",
      source: null,
    });
    const report = await runGuidedSetup("shop_1", "admin@example.com", TIMING);
    expect(report.ok).toBe(false);
    expect(report.fatal).toContain("Settings → Klaviyo");
    expect(report.rows).toHaveLength(flowSpecs().length);
    expect(report.rows.every((r) => r.status === "unchecked")).toBe(true);
    expect(mocks.apiRequests).toHaveLength(0);
  });
});

describe("alert budget (staleOrMissingCoverage)", () => {
  it("never arms before the wizard has run", async () => {
    mocks.settings.set("klaviyoFlowSetup", {
      checkedAt: "2026-08-01T00:00:00.000Z",
      lastAttemptAt: "2026-08-01T00:00:00.000Z",
      setupRanAt: null, // checklist visited, wizard never run
      rows: [{ metric: "M", status: "missing", flowId: "", flowName: "", ours: false }],
    });
    expect(await staleOrMissingCoverage("shop_1", new Date())).toBeNull();
  });

  it("skips the tick while a verify/setup task is running (fresh persisted record) — never judges coverage mid-setup, never calls Klaviyo; a stale record (dead process) does not block", async () => {
    const dayOld = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    addAllSpecMetrics(); // a real re-verify would read "missing" for every row
    const runningTask = (updatedAt: string) => ({
      id: "t1",
      kind: "setup",
      state: "running",
      startedAt: updatedAt,
      updatedAt,
      finishedAt: null,
      step: "creating",
      message: "Creating flow 3 of 27…",
      done: 2,
      total: 27,
      report: null,
      error: null,
    });
    mocks.settings.set("klaviyoFlowSetup", {
      checkedAt: dayOld,
      lastAttemptAt: dayOld,
      setupRanAt: dayOld,
      rows: [{ metric: "Cellexia Upcoming Order", status: "live", flowId: "f", flowName: "F", ours: true }],
      task: runningTask(new Date().toISOString()),
    });
    const client = await import("~/lib/klaviyo/client.server");
    expect(await staleOrMissingCoverage("shop_1", new Date())).toBeNull();
    expect(client.klaviyoApiRequest).not.toHaveBeenCalled();
    // Nothing persisted either — the run owns the record.
    const cached = mocks.settings.get("klaviyoFlowSetup") as { checkedAt: string; rows: unknown[] };
    expect(cached.checkedAt).toBe(dayOld);
    expect(cached.rows).toHaveLength(1);

    // A running record silent for > 90 s is a dead process: the sweep proceeds.
    mocks.settings.set("klaviyoFlowSetup", {
      checkedAt: dayOld,
      lastAttemptAt: dayOld,
      setupRanAt: dayOld,
      rows: [],
      task: runningTask(new Date(Date.now() - FLOW_TASK_STALE_MS - 1_000).toISOString()),
    });
    const result = await staleOrMissingCoverage("shop_1", new Date());
    expect(client.klaviyoApiRequest).toHaveBeenCalled();
    expect(result?.missing.length).toBe(flowSpecs().length);
  });

  it("a FAILED refresh still advances the daily budget (no 15-minute polling loop)", async () => {
    mocks.settings.set("klaviyoFlowSetup", {
      checkedAt: null,
      lastAttemptAt: null,
      setupRanAt: "2026-08-01T00:00:00.000Z",
      rows: [],
    });
    // The index read fails (Events-only key → 403, not retried).
    const client = await import("~/lib/klaviyo/client.server");
    (client.klaviyoApiRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 403,
      error: "forbidden",
    });
    expect(await staleOrMissingCoverage("shop_1", new Date())).toBeNull();
    expect(client.klaviyoApiRequest).toHaveBeenCalledTimes(1); // 403 is not retried
    const cached = mocks.settings.get("klaviyoFlowSetup") as {
      lastAttemptAt: string | null;
      setupRanAt: string | null;
    };
    expect(cached.lastAttemptAt).toBeTruthy();
    expect(cached.setupRanAt).toBe("2026-08-01T00:00:00.000Z");
    // Within the budget window nothing hits Klaviyo again.
    (client.klaviyoApiRequest as ReturnType<typeof vi.fn>).mockClear();
    expect(await staleOrMissingCoverage("shop_1", new Date())).toBeNull();
    expect(client.klaviyoApiRequest).not.toHaveBeenCalled();
  });

  it("reports only genuinely uncovered Klaviyo-delivered metrics from fresh cache", async () => {
    mocks.settings.set("klaviyoFlowSetup", {
      checkedAt: new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
      setupRanAt: new Date().toISOString(),
      rows: [
        { metric: "A", status: "live", flowId: "f", flowName: "F", ours: true },
        { metric: "B", status: "missing", flowId: "", flowName: "", ours: false },
        { metric: "C", status: "not_live", flowId: "f2", flowName: "F2", ours: true },
        { metric: "D", status: "app_delivers", flowId: "", flowName: "", ours: false },
        { metric: "E", status: "off", flowId: "", flowName: "", ours: false },
      ],
    });
    const result = await staleOrMissingCoverage("shop_1", new Date());
    expect(result?.missing.sort()).toEqual(["B", "C"]);
  });
});
