import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Emails tab (v1.16.0): the catalog contract, merchant content overrides,
 * and the router's new per-template controls.
 *
 * Pinned here:
 *  - CATALOG COMPLETENESS: every TemplateKey has a catalog descriptor, every
 *    timing pointer targets a real settings path, and the system templates
 *    keep their built-in copy / can never be disabled.
 *  - renderEmail overrides: non-empty merchant subject/body replace the
 *    catalog copy with {var} interpolation (unknown placeholders stay
 *    visible), empty overrides fall back, and the plain-text twin renders.
 *  - sendNotification: enabled:false suppresses (reason template_disabled,
 *    critical templates bypass), the rendered content_subject/content_html/
 *    content_text ride the Klaviyo event properties (override applied, links
 *    substituted), and none of that content is persisted in NotificationLog.
 */

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  outbox: [] as Row[],
  logs: [] as Row[],
  seq: 0,
}));

const mocks = vi.hoisted(() => ({
  isKlaviyoConfigured: vi.fn(async (): Promise<boolean> => true),
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  isSetupMode: vi.fn(async (): Promise<boolean> => false),
  /** When set, the outbox dedupe probe reports this pre-existing row. */
  dedupeHit: null as Record<string, unknown> | null,
  emailsSetting: {
    templates: {} as Record<
      string,
      { enabled: boolean; subject: string; body: string }
    >,
  },
  sendEmail: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/db.server", () => {
  const client = {
    klaviyoOutbox: {
      findFirst: vi.fn(
        async (): Promise<Row | null> => mocks.dedupeHit ?? null,
      ),
      create: vi.fn(
        async (args: { data: Record<string, unknown> }): Promise<Row> => {
          const row: Row = {
            id: `obx_${++store.seq}`,
            status: "PENDING",
            ...args.data,
          };
          store.outbox.push(row);
          return row;
        },
      ),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: Record<string, unknown>;
        }): Promise<Row | null> => {
          const row =
            mocks.dedupeHit && mocks.dedupeHit.id === args.where.id
              ? mocks.dedupeHit
              : (store.outbox.find((r) => r.id === args.where.id) ?? null);
          if (row) Object.assign(row, args.data);
          return row;
        },
      ),
    },
    notificationLog: {
      create: vi.fn(
        async (args: { data: Record<string, unknown> }): Promise<Row> => {
          const row: Row = { id: `nlg_${++store.seq}`, ...args.data };
          store.logs.push(row);
          return row;
        },
      ),
      findFirst: vi.fn(async (): Promise<null> => null),
    },
    subscriptionContract: {
      findUnique: vi.fn(async (): Promise<unknown> => ({
        id: "ctr_1",
        shopId: "shop_1",
        customerId: "gid://shopify/Customer/1",
        email: "anna@example.com",
        phone: null,
        locale: "en",
        ownership: "OURS",
        isDemo: false,
        lines: [],
      })),
    },
    shop: {
      findUnique: vi.fn(async (): Promise<unknown> => ({
        id: "shop_1",
        ianaTimezone: "Europe/Zurich",
        contactEmail: null,
      })),
    },
  };
  return { default: client };
});

vi.mock("~/lib/klaviyo/client.server", () => ({
  isKlaviyoConfigured: mocks.isKlaviyoConfigured,
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/launch/launch.server", () => ({
  isSetupMode: mocks.isSetupMode,
}));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "notifications") {
      return { channels: { email: true, sms: true } };
    }
    if (key === "alerts") return { emailTo: [] };
    if (key === "emails") return mocks.emailsSetting;
    return {};
  }),
}));
vi.mock("~/lib/notifications/mailer.server", () => ({
  sendEmail: mocks.sendEmail,
}));
vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildPortalUrl: vi.fn(async (): Promise<string> => "https://portal"),
  buildActionLinkBundle: vi.fn(
    async (): Promise<Record<string, string>> => ({
      skip_url: "https://magic/skip",
      delay_1w_url: "https://magic/delay1w",
      delay_3w_url: "https://magic/delay3w",
      update_card_url: "https://magic/card",
      pause_url: "https://magic/pause",
    }),
  ),
}));
vi.mock("~/lib/klaviyo/events-map.server", () => ({
  CELLEXIA_SEND_PROPERTY: "cellexia_send",
  contractProfileAttrs: vi.fn((): Record<string, unknown> => ({})),
  contractSnapshotProperties: vi.fn(
    async (): Promise<Record<string, unknown>> => ({
      portal_url: "https://portal",
    }),
  ),
}));

import {
  EMAIL_CATALOG,
  emailCatalogEntries,
} from "~/lib/notifications/catalog.server";
import {
  TEMPLATES,
  renderEmail,
  interpolateVars,
  type TemplateKey,
} from "~/lib/notifications/templates.server";
import { defaultFor } from "~/lib/settings/registry.server";
import { sendNotification } from "~/lib/notifications/send.server";

beforeEach(() => {
  vi.clearAllMocks();
  store.outbox = [];
  store.logs = [];
  store.seq = 0;
  mocks.emailsSetting.templates = {};
  mocks.dedupeHit = null;
});

// ── Catalog contract ─────────────────────────────────────────────────────────

describe("email catalog", () => {
  it("covers every template in the registry — a new template cannot ship uncataloged", () => {
    const templateKeys = Object.keys(TEMPLATES).sort();
    const catalogKeys = Object.keys(EMAIL_CATALOG).sort();
    expect(catalogKeys).toEqual(templateKeys);
    for (const entry of emailCatalogEntries()) {
      expect(entry.title.length, entry.template).toBeGreaterThan(0);
      expect(entry.trigger.length, entry.template).toBeGreaterThan(0);
    }
  });

  it("every timing pointer targets a real path in its settings group", () => {
    for (const entry of emailCatalogEntries()) {
      if (!entry.timing) continue;
      const defaults = defaultFor(entry.timing.settingsKey) as Record<
        string,
        unknown
      >;
      expect(
        Object.prototype.hasOwnProperty.call(defaults, entry.timing.path),
        `${entry.template}: ${entry.timing.settingsKey}.${entry.timing.path}`,
      ).toBe(true);
      // The declared kind matches the default's shape.
      const value = defaults[entry.timing.path];
      if (entry.timing.kind === "intList") {
        expect(Array.isArray(value), entry.template).toBe(true);
      } else {
        expect(typeof value, entry.template).toBe("number");
      }
    }
  });

  it("system mail keeps built-in copy and can never be disabled", () => {
    for (const template of ["otp_code", "admin_alert", "import_summary"] as const) {
      expect(EMAIL_CATALOG[template].customizable).toBe(false);
      expect(EMAIL_CATALOG[template].disableable).toBe(false);
    }
    // Every critical template is non-disableable — the catalog must agree
    // with the router's bypass rule.
    for (const [key, def] of Object.entries(TEMPLATES)) {
      if (def.critical) {
        expect(
          EMAIL_CATALOG[key as TemplateKey].disableable,
          key,
        ).toBe(false);
      }
    }
  });
});

// ── Override rendering ───────────────────────────────────────────────────────

describe("renderEmail with merchant overrides", () => {
  it("interpolates {vars} into override copy; unknown placeholders stay visible", () => {
    expect(
      interpolateVars("Your box ships {next_date} — {delay_1w_ur}", {
        next_date: "12 Aug",
      }),
    ).toBe("Your box ships 12 Aug — {delay_1w_ur}");
  });

  it("non-empty override replaces the catalog copy in subject, html and text", () => {
    const rendered = renderEmail(
      "upcoming_order",
      "en",
      { next_date: "12 Aug", delay_1w_url: "https://magic/delay1w" },
      {
        subject: "Coming {next_date}!",
        body: "Need more time? One click: {delay_1w_url}",
      },
    );
    expect(rendered.subject).toBe("Coming 12 Aug!");
    // v1.17.0: bare URLs in the body are auto-linked in the HTML shape —
    // the substituted link must appear as a real anchor, and verbatim in
    // the plain-text twin.
    expect(rendered.html).toContain("One click: ");
    expect(rendered.html).toContain('href="https://magic/delay1w"');
    expect(rendered.text).toContain("One click: https://magic/delay1w");
  });

  it("empty override falls back to the built-in catalog copy", () => {
    const builtIn = renderEmail("upcoming_order", "en", { next_date: "12 Aug" });
    const viaEmptyOverride = renderEmail(
      "upcoming_order",
      "en",
      { next_date: "12 Aug" },
      { subject: "", body: "  " },
    );
    expect(viaEmptyOverride.subject).toBe(builtIn.subject);
    expect(viaEmptyOverride.html).toBe(builtIn.html);
  });
});

// ── Router: per-template controls + content properties ───────────────────────

describe("sendNotification — per-template controls (v1.16.0)", () => {
  it("suppresses a disabled template with reason template_disabled", async () => {
    mocks.emailsSetting.templates.upcoming_order = {
      enabled: false,
      subject: "",
      body: "",
    };
    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "upcoming_order",
    });
    expect(result.status).toBe("SUPPRESSED");
    expect(store.outbox).toHaveLength(0);
    const log = store.logs[0] as { status: string; payload: Row };
    expect(log.status).toBe("SUPPRESSED");
    expect(log.payload.reason).toBe("template_disabled");
  });

  it("a critical template ignores enabled:false (delivery is not optional)", async () => {
    mocks.emailsSetting.templates.threeds_action = {
      enabled: false,
      subject: "",
      body: "",
    };
    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "threeds_action",
      vars: { cta_url: "https://bank" },
    });
    expect(result.status).toBe("SENT");
    // Klaviyo event enqueued AND direct SMTP delivered (critical).
    expect(store.outbox).toHaveLength(1);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("attaches rendered content properties to the Klaviyo event — override applied, links substituted", async () => {
    mocks.emailsSetting.templates.upcoming_order = {
      enabled: true,
      subject: "Your Cellexia box — {next_date}",
      body: "Push it back a week in one click: {delay_1w_url}",
    };
    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "upcoming_order",
      vars: { next_date: "12 Aug", cycleIndex: 3 },
    });
    expect(result.status).toBe("SENT");
    const properties = (store.outbox[0] as { properties: Row }).properties;
    expect(properties.content_subject).toBe("Your Cellexia box — 12 Aug");
    // v1.17.0: the substituted magic link is auto-linked in content_html.
    expect(String(properties.content_html)).toContain(
      "Push it back a week in one click: ",
    );
    expect(String(properties.content_html)).toContain(
      'href="https://magic/delay1w"',
    );
    expect(String(properties.content_text)).toContain("https://magic/delay1w");
    // The one-tap links still travel as their own properties for flows that
    // reference them directly.
    expect(properties.skip_url).toBe("https://magic/skip");
  });

  it("never persists rendered content (or links) in NotificationLog", async () => {
    mocks.emailsSetting.templates.upcoming_order = {
      enabled: true,
      subject: "S",
      body: "One click: {delay_1w_url}",
    };
    await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "upcoming_order",
      vars: { cycleIndex: 3 },
    });
    const serialized = JSON.stringify(store.logs);
    expect(serialized).not.toContain("content_html");
    expect(serialized).not.toContain("https://magic/delay1w");
  });

  it("grafts content_* onto a deduped PENDING twin — the event-map row must not eat the content", async () => {
    // The state-change event (same metric, same contract) enqueued first —
    // the outbox dedupe would normally discard the router's content-carrying
    // enqueue entirely, and a flow built as {{ event.content_html }} would
    // render empty (deterministic for milestone_gift / rewards_unlocked /
    // gift_announcement / webhook-path payment_failed_1).
    // events-map.server.ts stamps cellexia_send:"false" on every canonical
    // row unconditionally (never omits it) — the fixture mirrors that real
    // shape rather than a row that happens to lack the property.
    mocks.dedupeHit = {
      id: "obx_prior",
      status: "PENDING",
      properties: {
        event_type: "lifecycle.milestone_reached",
        contract_id: "ctr_1",
        cellexia_send: "false",
      },
    };
    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "milestone_gift",
      vars: { cycleIndex: 6 },
    });
    expect(result.status).toBe("SENT");
    expect(store.outbox).toHaveLength(0); // deduped — no second row
    const grafted = mocks.dedupeHit.properties as Row;
    expect(typeof grafted.content_html).toBe("string");
    expect(typeof grafted.content_subject).toBe("string");
    // The flow-filter verdict rides the graft too (v1.18.0): the prior row
    // was contentless, so its "false" was never a finalized verdict — the
    // first content-bearing duplicate legitimately supersedes it. Without
    // this an auto-created flow would stay silent on the surviving row.
    expect(grafted.cellexia_send).toBe("true");
    // Existing event properties survive the graft.
    expect(grafted.event_type).toBe("lifecycle.milestone_reached");
  });

  it("a row that already has content keeps its verdict — no re-graft once finalized", async () => {
    // Once a row has been finalized with real content, its verdict is
    // trustworthy and must never move again — e.g. a provenance-gated
    // "false" twin (a merge-cancel's webhook echo) that already rendered
    // must keep its verdict even if a later duplicate lands for the same
    // metric+contract; flipping it would email a customer who never acted.
    mocks.dedupeHit = {
      id: "obx_prior",
      status: "PENDING",
      properties: {
        event_type: "lifecycle.milestone_reached",
        contract_id: "ctr_1",
        cellexia_send: "false",
        content_html: "<p>original</p>",
        content_text: "original",
      },
    };
    await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "milestone_gift",
      vars: { cycleIndex: 6 },
    });
    const grafted = mocks.dedupeHit.properties as Row;
    expect(grafted.content_html).toBe("<p>original</p>"); // untouched
    expect(grafted.cellexia_send).toBe("false"); // untouched
  });

  it("SMS templates carry content_text but no subject/html", async () => {
    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "payment_failed_sms",
      vars: { amount: "CHF 64.00" },
    });
    expect(result.status).toBe("SENT");
    const properties = (store.outbox[0] as { properties: Row }).properties;
    expect(typeof properties.content_text).toBe("string");
    expect(properties.content_subject).toBeUndefined();
    expect(properties.content_html).toBeUndefined();
  });
});
