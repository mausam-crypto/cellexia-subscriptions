import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Per-template sender model (v1.17.0, send.server.ts).
 *
 * Pinned here:
 *  - sender "auto" keeps the pre-1.17.0 behavior EXACTLY: Klaviyo event when
 *    a key is configured, direct-SMTP fallback (EMAIL) / honest suppression
 *    (SMS) otherwise.
 *  - sender "app" forces direct SMTP and NEVER enqueues the delivery metric
 *    (a flow on the same metric must not double-send); the SENT row keeps
 *    the dedupe-vars payload shape the dunning ladder relies on.
 *  - sender "klaviyo" forces the event; without a key the send is SUPPRESSED
 *    (klaviyo_unconfigured) — an explicit choice never silently reroutes.
 *  - critical templates deliver their direct-SMTP copy exactly once under
 *    every sender value.
 *  - SMS templates ignore "app" (no SMTP transport exists for SMS).
 *  - the emailDesign setting flows into rendered content (content_html and
 *    the SMTP body use the merchant's brand kit).
 */

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  outbox: [] as Row[],
  logs: [] as Row[],
  seq: 0,
}));

const mocks = vi.hoisted(() => ({
  isKlaviyoConfigured: vi.fn(async (): Promise<boolean> => true),
  logEvent: vi.fn(async (): Promise<void> => {}),
  isSetupMode: vi.fn(async (): Promise<boolean> => false),
  emailsSetting: {
    templates: {} as Record<
      string,
      { enabled?: boolean; subject?: string; body?: string; sender?: string }
    >,
  },
  emailDesignSetting: {} as Record<string, unknown>,
  sendEmail: vi.fn(async (_input: Record<string, unknown>): Promise<void> => {}),
}));

vi.mock("~/db.server", () => {
  const client = {
    klaviyoOutbox: {
      findMany: vi.fn(async (): Promise<Row[]> => []),
      create: vi.fn(
        async (args: { data: Record<string, unknown> }): Promise<Row> => {
          const row: Row = { id: `obx_${++store.seq}`, status: "PENDING", ...args.data };
          store.outbox.push(row);
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
        phone: "+41790000000",
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
vi.mock("~/lib/launch/launch.server", () => ({ isSetupMode: mocks.isSetupMode }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "notifications") return { channels: { email: true, sms: true } };
    if (key === "alerts") return { emailTo: [] };
    if (key === "emails") return mocks.emailsSetting;
    if (key === "emailDesign") return mocks.emailDesignSetting;
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

import { sendNotification } from "~/lib/notifications/send.server";

beforeEach(() => {
  vi.clearAllMocks();
  store.outbox = [];
  store.logs = [];
  store.seq = 0;
  mocks.emailsSetting.templates = {};
  mocks.emailDesignSetting = {};
  mocks.isKlaviyoConfigured.mockResolvedValue(true);
});

describe("sender: app", () => {
  it("sends via direct SMTP and never enqueues the delivery metric", async () => {
    mocks.emailsSetting.templates.upcoming_order = { sender: "app" };
    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "upcoming_order",
      vars: { next_date: "12 Aug", cycleIndex: 3 },
    });
    expect(result.status).toBe("SENT");
    expect(result.directEmailSent).toBe(true);
    expect(result.klaviyoEnqueued).toBe(false);
    expect(store.outbox).toHaveLength(0);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    // The EMAIL SENT row keeps the dedupe payload shape (cycleIndex + vars).
    const sent = store.logs.find((l) => l.status === "SENT") as {
      channel: string;
      payload: { cycleIndex?: number; vars?: Record<string, unknown> };
    };
    expect(sent.channel).toBe("EMAIL");
    expect(sent.payload.cycleIndex).toBe(3);
    expect(sent.payload.vars?.next_date).toBe("12 Aug");
  });

  it("a critical template still delivers direct SMTP exactly once (no enqueue)", async () => {
    mocks.emailsSetting.templates.threeds_action = { sender: "app" };
    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "threeds_action",
      vars: { cta_url: "https://bank" },
    });
    expect(result.status).toBe("SENT");
    expect(store.outbox).toHaveLength(0);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("an SMS template ignores sender app (no SMTP transport for SMS)", async () => {
    mocks.emailsSetting.templates.payment_failed_sms = { sender: "app" };
    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "payment_failed_sms",
      vars: { amount: "CHF 64.00" },
    });
    // Klaviyo configured → behaves like auto: the event is enqueued — but
    // stamped cellexia_send "false" (content_text only; an EMAIL flow on
    // the shared metric must not fire a blank email off the SMS leg).
    expect(result.status).toBe("SENT");
    expect(store.outbox).toHaveLength(1);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    const properties = (store.outbox[0] as { properties: Row }).properties;
    expect(properties.cellexia_send).toBe("false");
  });

  it("phone-only contract (no email) logs a FAILED row — never a silent no-row failure", async () => {
    const db = (await import("~/db.server")).default as unknown as {
      subscriptionContract: { findUnique: ReturnType<typeof vi.fn> };
    };
    db.subscriptionContract.findUnique.mockResolvedValueOnce({
      id: "ctr_1",
      shopId: "shop_1",
      customerId: "gid://shopify/Customer/1",
      email: null,
      phone: "+41790000000",
      locale: "en",
      ownership: "OURS",
      isDemo: false,
      lines: [],
    });
    mocks.emailsSetting.templates.upcoming_order = { sender: "app" };
    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "upcoming_order",
      vars: { cycleIndex: 3 },
    });
    expect(result.status).toBe("FAILED");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    // The module contract: every send/suppression/failure lands in
    // NotificationLog — the Emails activity tab must show this.
    const failed = store.logs.find((l) => l.status === "FAILED") as {
      error?: string;
      payload?: { cycleIndex?: number };
    };
    expect(failed).toBeDefined();
    expect(String(failed.error)).toContain("no email recipient");
    expect(failed.payload?.cycleIndex).toBe(3);
  });

  it("SMTP failure lands as FAILED, never SENT", async () => {
    mocks.emailsSetting.templates.upcoming_order = { sender: "app" };
    mocks.sendEmail.mockRejectedValueOnce(new Error("relay down"));
    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "upcoming_order",
    });
    expect(result.status).toBe("FAILED");
    expect(store.logs.some((l) => l.status === "SENT")).toBe(false);
  });
});

describe("sender: klaviyo", () => {
  it("enqueues the event only (no SMTP) when configured", async () => {
    mocks.emailsSetting.templates.upcoming_order = { sender: "klaviyo" };
    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "upcoming_order",
    });
    expect(result.status).toBe("SENT");
    expect(result.klaviyoEnqueued).toBe(true);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("suppresses honestly when Klaviyo is unconfigured — never silently reroutes to SMTP", async () => {
    mocks.isKlaviyoConfigured.mockResolvedValue(false);
    mocks.emailsSetting.templates.upcoming_order = { sender: "klaviyo" };
    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "upcoming_order",
    });
    expect(result.status).toBe("SUPPRESSED");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    const log = store.logs[0] as { status: string; payload: Row };
    expect(log.status).toBe("SUPPRESSED");
    expect(log.payload.reason).toBe("klaviyo_unconfigured");
  });
});

describe("sender: auto (the pre-1.17.0 contract)", () => {
  it("enqueues the Klaviyo event when configured — stamped cellexia_send 'true' for the flow filter", async () => {
    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "upcoming_order",
    });
    expect(result.status).toBe("SENT");
    expect(result.klaviyoEnqueued).toBe(true);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    const properties = (store.outbox[0] as { properties: Row }).properties;
    expect(properties.cellexia_send).toBe("true");
  });

  it("falls back to direct SMTP when unconfigured (EMAIL)", async () => {
    mocks.isKlaviyoConfigured.mockResolvedValue(false);
    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "upcoming_order",
    });
    expect(result.status).toBe("SENT");
    expect(result.directEmailSent).toBe(true);
    expect(store.outbox).toHaveLength(0);
  });

  it("suppresses SMS when unconfigured", async () => {
    mocks.isKlaviyoConfigured.mockResolvedValue(false);
    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "payment_failed_sms",
    });
    expect(result.status).toBe("SUPPRESSED");
  });
});

describe("brand kit in rendered content", () => {
  it("content_html carries the merchant's design", async () => {
    mocks.emailDesignSetting = {
      ...Object.fromEntries([]),
      wordmark: "A C M E",
      buttonColor: "#222299",
    };
    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "upcoming_order",
      vars: { next_date: "12 Aug" },
    });
    expect(result.status).toBe("SENT");
    const properties = (store.outbox[0] as { properties: Row }).properties;
    expect(String(properties.content_html)).toContain("A C M E");
    expect(String(properties.content_html)).not.toContain("C E L L E X I A");
  });

  it("the direct-SMTP body carries the design too", async () => {
    mocks.isKlaviyoConfigured.mockResolvedValue(false);
    mocks.emailDesignSetting = { wordmark: "A C M E" };
    await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "upcoming_order",
    });
    const call = mocks.sendEmail.mock.calls[0]?.[0] as
      | { html?: string }
      | undefined;
    expect(String(call?.html)).toContain("A C M E");
  });

  it("a broken emailDesign read falls back to the default shell, never blocks the send", async () => {
    const settings = await import("~/lib/settings/settings.server");
    (settings.getSetting as ReturnType<typeof vi.fn>).mockImplementation(
      async (_shopId: string, key: string) => {
        if (key === "emailDesign") throw new Error("db down");
        if (key === "notifications") return { channels: { email: true, sms: true } };
        if (key === "emails") return mocks.emailsSetting;
        if (key === "alerts") return { emailTo: [] };
        return {};
      },
    );
    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "upcoming_order",
    });
    expect(result.status).toBe("SENT");
    const properties = (store.outbox[0] as { properties: Row }).properties;
    expect(String(properties.content_html)).toContain("C E L L E X I A");
  });
});
