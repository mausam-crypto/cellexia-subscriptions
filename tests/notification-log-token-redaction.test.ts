import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Notification router hygiene (v1.28.0 Stage F review fixes):
 *
 *  1. Signed magic-link tokens are NEVER persisted in NotificationLog.payload
 *     — neither as `*_url` vars nor inside pre-composed blocks that embed
 *     them (options_block, cta_url). Dedupe keys and dates still are.
 *  2. cancel_confirmed / winback_soft bodies reference {restart_url}
 *     unconditionally: when the mint fails the router degrades the link to
 *     portal_url — the literal placeholder must never reach a customer.
 *
 * Drives the REAL sendNotification over mocked seams (the
 * tests/klaviyo-unconfigured-fallback.test.ts harness).
 */

const mocks = vi.hoisted(() => ({
  notificationLogCreate: vi.fn(
    async (_args: { data: Record<string, unknown> }): Promise<unknown> => ({}),
  ),
  contractFindUnique: vi.fn(async (): Promise<unknown> => null),
  shopFindUnique: vi.fn(async (): Promise<unknown> => null),
  isSetupMode: vi.fn(async (): Promise<boolean> => false),
  isKlaviyoConfigured: vi.fn((): boolean => false),
  getSetting: vi.fn(async (_shopId: string, _key: string): Promise<unknown> => ({})),
  enqueue: vi.fn(async (): Promise<{ id: string } | null> => ({ id: "obx_1" })),
  logEvent: vi.fn(async (_input: unknown): Promise<void> => {}),
  sendEmail: vi.fn(
    async (_mail: { to: string; subject: string; html: string }): Promise<void> => {},
  ),
  buildPortalUrl: vi.fn(async (): Promise<string> => "https://www.cellexia.example/apps/cellexia-subs/"),
  buildActionLinkBundle: vi.fn(async (): Promise<Record<string, string>> => ({})),
  restartLinkVars: vi.fn(async (): Promise<Record<string, string>> => ({})),
}));

vi.mock("~/db.server", () => ({
  default: {
    notificationLog: { create: mocks.notificationLogCreate },
    subscriptionContract: { findUnique: mocks.contractFindUnique },
    shop: { findUnique: mocks.shopFindUnique },
  },
}));
vi.mock("~/lib/launch/launch.server", () => ({ isSetupMode: mocks.isSetupMode }));
vi.mock("~/lib/klaviyo/client.server", () => ({ isKlaviyoConfigured: mocks.isKlaviyoConfigured }));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));
vi.mock("~/lib/klaviyo/outbox.server", () => ({ enqueue: mocks.enqueue }));
vi.mock("~/lib/klaviyo/events-map.server", () => ({
  CELLEXIA_SEND_PROPERTY: "cellexia_send",
  contractProfileAttrs: vi.fn(() => ({})),
  contractSnapshotProperties: vi.fn(async () => ({
    portal_url: "https://www.cellexia.example/apps/cellexia-subs/",
    first_name: "Anna",
  })),
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildPortalUrl: mocks.buildPortalUrl,
  buildActionLinkBundle: mocks.buildActionLinkBundle,
}));
vi.mock("~/lib/notifications/mailer.server", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("~/lib/winback/links.server", () => ({ restartLinkVars: mocks.restartLinkVars }));

import { sendNotification } from "~/lib/notifications/send.server";

const CONTRACT = {
  id: "ctr_1",
  shopId: "shop_1",
  customerId: "gid://shopify/Customer/1",
  email: "anna@example.com",
  locale: "en",
  status: "CANCELLED",
  ownership: "OURS",
  isDemo: false,
  cancelReason: "TOO_EXPENSIVE",
  lines: [],
};

function loggedRows(): Record<string, unknown>[] {
  return mocks.notificationLogCreate.mock.calls.map(
    (c) => (c[0] as { data: Record<string, unknown> }).data,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isSetupMode.mockResolvedValue(false);
  mocks.isKlaviyoConfigured.mockReturnValue(false);
  mocks.contractFindUnique.mockResolvedValue(CONTRACT);
  mocks.shopFindUnique.mockResolvedValue({
    id: "shop_1",
    ianaTimezone: "Europe/London",
    contactEmail: "owner@cellexia.example",
  });
  mocks.restartLinkVars.mockResolvedValue({});
  mocks.getSetting.mockImplementation(async (_shopId: string, key: string) => {
    if (key === "notifications") return { channels: { email: true, sms: true } };
    if (key === "alerts") return { emailTo: ["ops@cellexia.example"] };
    return {};
  });
});

describe("NotificationLog never persists magic-link tokens", () => {
  it("strips every var carrying a /magic/ URL (plain urls, cta_url and the pre-composed options_block), keeps dedupe keys", async () => {
    const skip = "https://app.example/magic/SKIP-TOKEN-1";
    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "cancel_intent_followup",
      email: "anna@example.com",
      vars: {
        reason: "TOO_MUCH_PRODUCT",
        step: "saves",
        reason_line: "You mentioned you had too much product.",
        options_block: `Skip my next order: ${skip}`,
        support_line: "Talk to us",
        skip_url: skip,
        delay_3w_url: "",
        set_frequency_url: "https://app.example/magic/SETFREQ-2",
        pause_url: "",
        cta_url: "https://www.cellexia.example/apps/cellexia-subs/subscription/ctr_1",
        manage_url: "https://www.cellexia.example/apps/cellexia-subs/subscription/ctr_1",
        cancel_url: "https://www.cellexia.example/apps/cellexia-subs/cancel/ctr_1",
        portal_url: "https://www.cellexia.example/apps/cellexia-subs/",
        dedupe_key: "intent:sess_1",
        cycleIndex: 3,
      },
    });
    expect(result.status).toBe("SENT");
    // The email itself still carries the links…
    const html = (mocks.sendEmail.mock.calls[0][0] as { html: string }).html;
    expect(html).toContain(skip);
    // …but the persisted row does not.
    const rows = loggedRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const vars = (row.payload as { vars?: Record<string, unknown> }).vars ?? {};
      expect(JSON.stringify(vars)).not.toContain("/magic/");
      expect(vars.skip_url).toBeUndefined();
      expect(vars.set_frequency_url).toBeUndefined();
      expect(vars.options_block).toBeUndefined();
      // Non-token vars survive for the dedupe queries.
      expect(vars.dedupe_key).toBe("intent:sess_1");
      expect(vars.reason).toBe("TOO_MUCH_PRODUCT");
      expect(vars.manage_url).toContain("/subscription/ctr_1");
    }
  });
});

describe("restart_url degrades to portal_url when the mint fails", () => {
  it("cancel_confirmed never renders the literal {restart_url}", async () => {
    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "cancel_confirmed",
      email: "anna@example.com",
      vars: {},
    });
    expect(result.status).toBe("SENT");
    expect(mocks.restartLinkVars).toHaveBeenCalled();
    const html = (mocks.sendEmail.mock.calls[0][0] as { html: string }).html;
    expect(html).not.toContain("{restart_url}");
    expect(html).toContain("https://www.cellexia.example/apps/cellexia-subs/");
  });

  it("winback_soft's button falls back to the portal link too; a minted link wins when present", async () => {
    let result = await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "winback_soft",
      email: "anna@example.com",
      vars: { predicted_empty_date: "2026-09-01T00:00:00.000Z", stage: 0 },
    });
    expect(result.status).toBe("SENT");
    let html = (mocks.sendEmail.mock.calls[0][0] as { html: string }).html;
    expect(html).not.toContain("{restart_url}");
    expect(html).not.toContain("{cta_url}");

    mocks.sendEmail.mockClear();
    mocks.restartLinkVars.mockResolvedValue({ restart_url: "https://app.example/magic/RESTART-9" });
    result = await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "winback_soft",
      email: "anna@example.com",
      vars: { predicted_empty_date: "2026-09-01T00:00:00.000Z", stage: 0 },
    });
    expect(result.status).toBe("SENT");
    html = (mocks.sendEmail.mock.calls[0][0] as { html: string }).html;
    expect(html).toContain("https://app.example/magic/RESTART-9");
    // …and that token is not in the persisted row.
    for (const row of loggedRows()) {
      expect(JSON.stringify(row.payload ?? {})).not.toContain("/magic/");
    }
  });
});
