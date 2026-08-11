import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Guided Klaviyo flow setup (v1.18.0, app/lib/klaviyo/flows.server.ts).
 *
 * Pinned here:
 *  - SPEC COVERAGE: every EMAIL-channel, metric-carrying, non-critical,
 *    non-dormant template appears in exactly one flow spec; the three
 *    payment-failed notices share ONE flow (one metric); threeds_action,
 *    SMS, system mail and dormant templates are excluded (with reasons).
 *  - DEFINITION SHAPE: metric trigger by id, the cellexia_send="true"
 *    string trigger filter (the safety interlock), one send-email action
 *    with {{ event.content_subject }} subject, the template id, smart
 *    sending OFF, and templates created with editor_type "CODE" (Klaviyo's
 *    enum for custom HTML — "html" is not a value).
 *  - API surface: every flows/templates request runs on the flows-capable
 *    revision (≥ 2025-01-15) regardless of the events revision; flow
 *    definitions are fetched per flow (the list endpoint cannot embed
 *    them) and an unreadable definition is FATAL — never "no flow here".
 *  - SENDER AWARENESS: app-delivered / disabled templates report
 *    app_delivers / off — never "missing", never flowed, never alerted.
 *  - COVERAGE EVALUATION: live flow (anyone's) = green; the merchant's own
 *    hand-built flow counts and is never duplicated; our drafts get their
 *    set-live retried on re-run; merchant drafts are never touched.
 *  - RATE LIMITS: creation paced + capped per run; 429 yields the friendly
 *    rate_limited status, never an error row, never a draft double-POST.
 *  - SEED SAFETY: metrics are materialized with cellexia_send "false"
 *    events — a seed can never send anyone an email.
 *  - ALERT BUDGET: staleOrMissingCoverage arms only after the wizard ran
 *    (setupRanAt) and counts failed attempts toward the daily budget.
 */

const mocks = vi.hoisted(() => ({
  auth: { apiKey: "pk_test", revision: "2024-10-15", source: "settings" as const },
  metricsPages: [] as Array<Record<string, unknown>>,
  /** Flow list rows: {id, attributes:{name,status,trigger_type}} + definitions. */
  flowsPages: [] as Array<Record<string, unknown>>,
  definitionsByFlowId: new Map<string, unknown>(),
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
}));

vi.mock("~/lib/klaviyo/client.server", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("~/lib/klaviyo/client.server")
  >();
  return {
    ...original, // keep flowsAuth + FLOWS_API_REVISION real
    resolveKlaviyoAuth: vi.fn(async () => mocks.auth),
    createKlaviyoEvent: vi.fn(async (input: Record<string, unknown>) => {
      mocks.createdEvents.push(input);
      return { ok: true, status: 202 };
    }),
    klaviyoApiList: vi.fn(
      async (auth: { revision: string }, path: string) => {
        mocks.apiRequests.push({ method: "GET", path, revision: auth.revision });
        if (path.startsWith("/api/metrics")) {
          return { ok: true, data: mocks.metricsPages };
        }
        if (path.startsWith("/api/flows")) {
          return { ok: true, data: mocks.flowsPages };
        }
        if (path.startsWith("/api/templates")) {
          const nameMatch = decodeURIComponent(path).match(/equals\(name,"(.+)"\)/);
          const id = nameMatch ? mocks.templatesByName.get(nameMatch[1]) : undefined;
          return { ok: true, data: id ? [{ id, attributes: {} }] : [] };
        }
        return { ok: true, data: [] };
      },
    ),
    klaviyoApiRequest: vi.fn(
      async (
        auth: { revision: string },
        method: string,
        path: string,
        body?: unknown,
      ) => {
        mocks.apiRequests.push({ method, path, body, revision: auth.revision });
        const flowDetail = path.match(/^\/api\/flows\/([^/?]+)\/\?/);
        if (method === "GET" && flowDetail) {
          const definition = mocks.definitionsByFlowId.get(flowDetail[1]);
          if (definition === "UNREADABLE") {
            return { ok: false, status: 500, error: "boom" };
          }
          return {
            ok: true,
            status: 200,
            json: { data: { attributes: { definition: definition ?? {} } } },
          };
        }
        if (method === "POST" && path.startsWith("/api/templates")) {
          const id = `tpl_${++mocks.nextId}`;
          return { ok: true, status: 201, json: { data: { id } } };
        }
        if (method === "POST" && path.startsWith("/api/flows")) {
          if (mocks.rateLimitFlowCreates) {
            return { ok: false, status: 429, error: "rate limited", retryAfterSeconds: 30 };
          }
          const id = `flow_${++mocks.nextId}`;
          return { ok: true, status: 201, json: { data: { id } } };
        }
        if (method === "PATCH") {
          if (mocks.failFlowPatch) return { ok: false, status: 500, error: "boom" };
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

import { FLOWS_API_REVISION } from "~/lib/klaviyo/client.server";
import {
  buildFlowDefinition,
  CELLEXIA_SEND_PROPERTY,
  effectiveDeliveryFor,
  evaluateCoverage,
  EXCLUDED_FROM_SETUP,
  flowSpecs,
  flowTemplateHtml,
  flowTemplateText,
  listFlowsWithTriggers,
  runGuidedSetup,
  staleOrMissingCoverage,
  type KlaviyoFlowInfo,
} from "~/lib/klaviyo/flows.server";
import { TEMPLATES, type TemplateKey } from "~/lib/notifications/templates.server";
import { EMAIL_CATALOG } from "~/lib/notifications/catalog.server";

const FAST: { seedPollDelayMs: number; createSpacingMs: number; definitionPaceMs: number } =
  { seedPollDelayMs: 1, createSpacingMs: 0, definitionPaceMs: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.metricsPages = [];
  mocks.flowsPages = [];
  mocks.definitionsByFlowId = new Map();
  mocks.templatesByName = new Map();
  mocks.apiRequests = [];
  mocks.createdEvents = [];
  mocks.settings = new Map();
  mocks.emailsSetting = { templates: {} };
  mocks.nextId = 0;
  mocks.failFlowPatch = false;
  mocks.rateLimitFlowCreates = false;
});

const metricRow = (id: string, name: string): Record<string, unknown> => ({
  id,
  attributes: { name },
});

/** Registers a flow in the mock list + its definition for the detail GET. */
function addFlow(input: {
  id: string;
  name: string;
  status: string;
  metricIds: string[];
}): void {
  mocks.flowsPages.push({
    id: input.id,
    attributes: { name: input.name, status: input.status, trigger_type: "Metric" },
  });
  mocks.definitionsByFlowId.set(input.id, {
    triggers: input.metricIds.map((id) => ({ type: "metric", id })),
  });
}

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

describe("API surface", () => {
  it("all flows/templates requests run on the flows-capable revision, even with an older events revision", async () => {
    mocks.auth = { ...mocks.auth, revision: "2024-10-15" };
    addFlow({ id: "f1", name: "X", status: "live", metricIds: [] });
    await listFlowsWithTriggers(mocks.auth, { paceMs: 0 });
    for (const request of mocks.apiRequests) {
      expect(request.revision >= FLOWS_API_REVISION, request.path).toBe(true);
    }
  });

  it("fetches definitions per flow; an unreadable definition is FATAL, never 'no flow here'", async () => {
    addFlow({ id: "f1", name: "Mine", status: "live", metricIds: ["MET1"] });
    mocks.definitionsByFlowId.set("f1", "UNREADABLE");
    const index = await listFlowsWithTriggers(mocks.auth, { paceMs: 0 });
    expect(index.ok).toBe(false);
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
    const report = await runGuidedSetup("shop_1", "admin@example.com", FAST);
    expect(report.ok).toBe(true);
    expect(report.seeded.length).toBe(flowSpecs().length);
    for (const event of mocks.createdEvents) {
      const props = event.properties as Record<string, unknown>;
      expect(props[CELLEXIA_SEND_PROPERTY]).toBe("false");
      expect(props.setup_seed).toBe(true);
      expect(event.email).toBe("admin@example.com");
    }
    expect(
      mocks.apiRequests.filter((r) => r.method === "POST" && r.path.includes("flows")),
    ).toHaveLength(0);
    for (const row of report.rows) {
      expect(row.status).toBe("pending_metric");
    }
  });

  it("creates template (editor_type CODE) + flow + sets it live for an uncovered metric — covered metrics untouched", async () => {
    const specs = flowSpecs();
    mocks.metricsPages = specs.map((s, i) => metricRow(`MET${i}`, s.metric));
    for (const [i, s] of specs.entries()) {
      if (s.metric === "Cellexia Upcoming Order") continue;
      addFlow({
        id: `existing_${i}`,
        name: `My ${s.metric} flow`,
        status: "live",
        metricIds: [`MET${i}`],
      });
    }

    const report = await runGuidedSetup("shop_1", "admin@example.com", FAST);
    expect(report.ok).toBe(true);
    expect(report.seeded).toHaveLength(0);

    const flowPosts = mocks.apiRequests.filter(
      (r) => r.method === "POST" && r.path.includes("flows"),
    );
    expect(flowPosts).toHaveLength(1); // ONLY the uncovered metric
    const body = flowPosts[0].body as {
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

    const upcomingRow = report.rows.find(
      (r) => r.metric === "Cellexia Upcoming Order",
    )!;
    expect(upcomingRow.status).toBe("live");
    expect(upcomingRow.ours).toBe(true);

    const cached = mocks.settings.get("klaviyoFlowSetup") as {
      rows: Array<{ metric: string; status: string }>;
      setupRanAt: string | null;
    };
    expect(cached.rows.length).toBe(specs.length);
    expect(cached.setupRanAt).toBeTruthy();
  });

  it("skips creating flows for app-delivered metrics (an inert flow helps nobody)", async () => {
    const specs = flowSpecs();
    mocks.metricsPages = specs.map((s, i) => metricRow(`MET${i}`, s.metric));
    mocks.emailsSetting = {
      templates: Object.fromEntries(
        specs.flatMap((s) => s.templates.map((t) => [t, { sender: "app" }])),
      ),
    };
    const report = await runGuidedSetup("shop_1", "admin@example.com", FAST);
    expect(report.ok).toBe(true);
    expect(
      mocks.apiRequests.filter((r) => r.method === "POST" && r.path.includes("flows")),
    ).toHaveLength(0);
    for (const row of report.rows) expect(row.status).toBe("app_delivers");
  });

  it("a 429 pauses the run with friendly rate_limited rows — no error rows, no draft double-POST", async () => {
    const specs = flowSpecs();
    mocks.metricsPages = specs.map((s, i) => metricRow(`MET${i}`, s.metric));
    mocks.rateLimitFlowCreates = true;
    const report = await runGuidedSetup("shop_1", "admin@example.com", FAST);
    expect(report.ok).toBe(true);
    const flowPosts = mocks.apiRequests.filter(
      (r) => r.method === "POST" && r.path.includes("flows"),
    );
    expect(flowPosts).toHaveLength(1); // stopped at the FIRST 429 — no retry storm
    expect(report.rows.every((r) => r.status === "rate_limited")).toBe(true);
    expect(report.rows[0].detail).toContain("again in a minute");
  });

  it("re-running sets OUR draft flows live ('click until green'), never the merchant's", async () => {
    const specs = flowSpecs();
    mocks.metricsPages = specs.map((s, i) => metricRow(`MET${i}`, s.metric));
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
    const report = await runGuidedSetup("shop_1", "admin@example.com", FAST);
    const patches = mocks.apiRequests.filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(1); // only OUR draft got the set-live retry
    const upcomingRow = report.rows.find(
      (r) => r.metric === "Cellexia Upcoming Order",
    )!;
    expect(upcomingRow.status).toBe("live");
    const merchantRow = report.rows.find(
      (r) => r.metric === "Cellexia Order Skipped",
    )!;
    expect(merchantRow.status).toBe("not_live");
  });

  it("reports a friendly fatal when no key is configured", async () => {
    const client = await import("~/lib/klaviyo/client.server");
    (client.resolveKlaviyoAuth as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      apiKey: null,
      revision: "2024-10-15",
      source: null,
    });
    const report = await runGuidedSetup("shop_1", "admin@example.com", FAST);
    expect(report.ok).toBe(false);
    expect(report.fatal).toContain("Settings → Klaviyo");
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

  it("a FAILED refresh still advances the daily budget (no 15-minute polling loop)", async () => {
    mocks.settings.set("klaviyoFlowSetup", {
      checkedAt: null,
      lastAttemptAt: null,
      setupRanAt: "2026-08-01T00:00:00.000Z",
      rows: [],
    });
    // Metrics read fails (Events-only key).
    const client = await import("~/lib/klaviyo/client.server");
    (client.klaviyoApiList as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 403,
      error: "forbidden",
    });
    expect(await staleOrMissingCoverage("shop_1", new Date())).toBeNull();
    const cached = mocks.settings.get("klaviyoFlowSetup") as {
      lastAttemptAt: string | null;
      setupRanAt: string | null;
    };
    expect(cached.lastAttemptAt).toBeTruthy();
    expect(cached.setupRanAt).toBe("2026-08-01T00:00:00.000Z");
    // Within the budget window nothing hits Klaviyo again.
    (client.klaviyoApiList as ReturnType<typeof vi.fn>).mockClear();
    expect(await staleOrMissingCoverage("shop_1", new Date())).toBeNull();
    expect(client.klaviyoApiList).not.toHaveBeenCalled();
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
