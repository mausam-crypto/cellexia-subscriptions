import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * NO KLAVIYO KEY MUST NEVER MEAN "SENT BUT DELIVERED TO NOBODY".
 *
 * Before this fix, sendNotification marked every metric template SENT the
 * moment enqueue() inserted an outbox row — but with KLAVIYO_PRIVATE_API_KEY
 * unset, flushKlaviyoOutbox leaves those rows PENDING forever. The dunning
 * ladder advanced (emailsSent++, NotificationLog dedupe rows written), the
 * launch checklist promised an "SMTP fallback" that did not exist, and the
 * customer received nothing while retries charged their card. If the key was
 * configured weeks later, the stale backlog fired flows on long-resolved
 * moments.
 *
 * The contract now (drives the REAL sendNotification over mocked seams,
 * tests/launch-mode.test.ts pattern):
 *  - key unset + EMAIL metric template → direct SMTP delivery (the checklist's
 *    promise made true), NO outbox enqueue, EMAIL SENT row carrying the vars
 *    the persistent dedupe queries match (dunning_dedupe / cycleIndex);
 *  - key unset + SMS template → SUPPRESSED (reason klaviyo_unconfigured) —
 *    there is no SMS transport, so nothing may claim SENT;
 *  - key unset + SMTP failure → FAILED (ladder retries; nothing advances);
 *  - key set → outbox path exactly as before, no direct email.
 */

const mocks = vi.hoisted(() => ({
  notificationLogCreate: vi.fn(
    async (_args: { data: Record<string, unknown> }): Promise<unknown> => ({}),
  ),
  contractFindUnique: vi.fn(async (): Promise<unknown> => null),
  shopFindUnique: vi.fn(async (): Promise<unknown> => null),
  isSetupMode: vi.fn(async (): Promise<boolean> => false),
  isKlaviyoConfigured: vi.fn((): boolean => false),
  getSetting: vi.fn(
    async (_shopId: string, _key: string): Promise<unknown> => ({}),
  ),
  enqueue: vi.fn(async (): Promise<void> => {}),
  logEvent: vi.fn(async (_input: unknown): Promise<void> => {}),
  sendEmail: vi.fn(
    async (_mail: { to: string; subject: string; html: string }): Promise<void> => {},
  ),
  buildPortalUrl: vi.fn(
    async (): Promise<string> => "https://www.cellexia.example/apps/cellexia/",
  ),
  buildActionLinkBundle: vi.fn(
    async (): Promise<Record<string, string>> => ({}),
  ),
  contractSnapshotProperties: vi.fn(
    async (): Promise<Record<string, unknown>> => ({}),
  ),
}));

vi.mock("~/db.server", () => ({
  default: {
    notificationLog: { create: mocks.notificationLogCreate },
    subscriptionContract: { findUnique: mocks.contractFindUnique },
    shop: { findUnique: mocks.shopFindUnique },
  },
}));

vi.mock("~/lib/launch/launch.server", () => ({
  isSetupMode: mocks.isSetupMode,
}));

vi.mock("~/lib/klaviyo/client.server", () => ({
  isKlaviyoConfigured: mocks.isKlaviyoConfigured,
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: mocks.getSetting,
}));

vi.mock("~/lib/klaviyo/outbox.server", () => ({
  enqueue: mocks.enqueue,
}));

vi.mock("~/lib/klaviyo/events-map.server", () => ({
  contractProfileAttrs: vi.fn(() => ({})),
  contractSnapshotProperties: mocks.contractSnapshotProperties,
}));

vi.mock("~/lib/events/log.server", () => ({
  logEvent: mocks.logEvent,
}));

vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildPortalUrl: mocks.buildPortalUrl,
  buildActionLinkBundle: mocks.buildActionLinkBundle,
}));

vi.mock("~/lib/notifications/mailer.server", () => ({
  sendEmail: mocks.sendEmail,
}));

import { sendNotification } from "~/lib/notifications/send.server";

type LogRow = { data: Record<string, unknown> };

function loggedRows(): Record<string, unknown>[] {
  return mocks.notificationLogCreate.mock.calls.map(
    (c) => (c[0] as LogRow).data,
  );
}

function rowFor(channel: string): Record<string, unknown> | undefined {
  return loggedRows().find((d) => d.channel === channel);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isSetupMode.mockResolvedValue(false);
  mocks.isKlaviyoConfigured.mockReturnValue(false);
  mocks.contractFindUnique.mockResolvedValue(null);
  mocks.shopFindUnique.mockResolvedValue({
    id: "shop_1",
    ianaTimezone: "Europe/London",
    contactEmail: "owner@cellexia.example",
  });
  mocks.getSetting.mockImplementation(async (_shopId: string, key: string) => {
    if (key === "notifications") {
      return { channels: { email: true, sms: true } };
    }
    if (key === "alerts") return { emailTo: ["ops@cellexia.example"] };
    return {};
  });
});

describe("sendNotification without KLAVIYO_PRIVATE_API_KEY", () => {
  it("delivers a dunning email via direct SMTP with the dedupe vars the ladder checks", async () => {
    const result = await sendNotification({
      shopId: "shop_1",
      template: "payment_failed_1",
      email: "anna@example.com",
      vars: {
        cycleIndex: 7,
        dunning_dedupe: "case_1:EMAIL:0",
        cta_url: "https://www.cellexia.example/m/tok",
      },
    });

    expect(result).toEqual({
      status: "SENT",
      klaviyoEnqueued: false,
      directEmailSent: true,
    });
    // The outbox must NOT hold a row that would fire a stale flow when the
    // key is configured weeks later.
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail.mock.calls[0]![0].to).toBe("anna@example.com");

    // No KLAVIYO_EVENT row exists, so the EMAIL SENT row must be matchable by
    // sendCaseNotificationOnce (payload.vars.dunning_dedupe, status SENT) and
    // hasSentForCycle (payload.cycleIndex).
    expect(rowFor("KLAVIYO_EVENT")).toBeUndefined();
    const emailRow = rowFor("EMAIL");
    expect(emailRow).toBeDefined();
    expect(emailRow?.status).toBe("SENT");
    expect(emailRow?.payload).toMatchObject({
      cycleIndex: 7,
      vars: { dunning_dedupe: "case_1:EMAIL:0" },
    });

    // The event log reports the channel that actually carried the message.
    const evt = mocks.logEvent.mock.calls[0]?.[0] as {
      type: string;
      payload: { channels: string[] };
    };
    expect(evt.type).toBe("notification.sent");
    expect(evt.payload.channels).toEqual(["EMAIL"]);
  });

  it("renders the one-tap magic links into the fallback upcoming_order email — no raw {skip_url}/{delay_3w_url} residue", async () => {
    // Contract-scoped send, exactly like reminders.server.ts: the link bundle
    // and the contract snapshot live in the Klaviyo `properties`; the SMTP
    // fallback must render from the SAME variable set or the customer gets
    // literal "{skip_url}" text and loses one-tap skip/delay entirely.
    mocks.contractFindUnique.mockResolvedValue({
      id: "c_1",
      shopId: "shop_1",
      customerId: "gid://shopify/Customer/5",
      email: "anna@example.com",
      phone: null,
      locale: "en",
      ownership: "OURS",
      isDemo: false,
      lines: [],
    });
    mocks.contractSnapshotProperties.mockResolvedValue({
      portal_url: "https://www.cellexia.example/apps/cellexia/",
    });
    mocks.buildActionLinkBundle.mockResolvedValue({
      skip_url: "https://www.cellexia.example/m/skip-tok",
      delay_1w_url: "https://www.cellexia.example/m/delay1-tok",
      delay_3w_url: "https://www.cellexia.example/m/delay3-tok",
      update_card_url: "https://www.cellexia.example/m/card-tok",
      pause_url: "https://www.cellexia.example/m/pause-tok",
    });

    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "c_1",
      template: "upcoming_order",
      locale: "en",
      vars: {
        cycleIndex: 2,
        items_summary: "Cellexia Serum × 1",
        item_count: 1,
        total_estimate: "CHF 89.00",
        total_estimate_cents: 8900,
        next_date: "12 August 2026",
        next_date_iso: "2026-08-12T09:00:00.000Z",
        frequency_weeks: 4,
      },
    });

    expect(result.status).toBe("SENT");
    expect(result.directEmailSent).toBe(true);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const mail = mocks.sendEmail.mock.calls[0]![0];

    // The one-tap actions the en body promises are real links...
    expect(mail.html).toContain("https://www.cellexia.example/m/skip-tok");
    expect(mail.html).toContain("https://www.cellexia.example/m/delay3-tok");
    expect(mail.html).toContain(
      "https://www.cellexia.example/apps/cellexia/",
    );
    // ...and NO placeholder survives unrendered anywhere in subject or body.
    expect(mail.html).not.toMatch(/\{[a-z0-9_]+\}/i);
    expect(mail.subject).not.toMatch(/\{[a-z0-9_]+\}/i);

    // Caller vars rendered too (the pre-fix behavior that must not regress).
    expect(mail.html).toContain("Cellexia Serum × 1");
    expect(mail.subject).toContain("12 August 2026");

    // Magic-link tokens must never be persisted: the SENT row's payload.vars
    // carries the caller's vars only, not the bundle.
    const emailRow = rowFor("EMAIL");
    expect(emailRow?.status).toBe("SENT");
    const persistedVars = (emailRow?.payload as Record<string, unknown>)
      .vars as Record<string, unknown>;
    expect(persistedVars.skip_url).toBeUndefined();
    expect(persistedVars.delay_3w_url).toBeUndefined();
    expect(JSON.stringify(emailRow?.payload)).not.toContain("skip-tok");
  });

  it("keeps hasSentForCycle's top-level cycleIndex on the fallback row", async () => {
    await sendNotification({
      shopId: "shop_1",
      template: "upcoming_order",
      email: "anna@example.com",
      vars: { cycleIndex: 4 },
    });

    const emailRow = rowFor("EMAIL");
    expect(emailRow?.status).toBe("SENT");
    expect(
      (emailRow?.payload as Record<string, unknown>).cycleIndex,
    ).toBe(4);
  });

  it("suppresses SMS honestly — there is no transport, so nothing may claim SENT", async () => {
    const result = await sendNotification({
      shopId: "shop_1",
      template: "payment_failed_sms",
      phone: "+447700900123",
      vars: { cycleIndex: 7, dunning_dedupe: "case_1:SMS:0" },
    });

    expect(result.status).toBe("SUPPRESSED");
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();

    const rows = loggedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("SUPPRESSED");
    expect(rows[0]!.payload).toMatchObject({ reason: "klaviyo_unconfigured" });
    // No SENT row anywhere: the ladder advances via SUPPRESSED without ever
    // recording a delivery that did not happen.
    expect(rows.some((r) => r.status === "SENT")).toBe(false);
  });

  it("reports FAILED when the SMTP fallback throws, so the ladder retries", async () => {
    mocks.sendEmail.mockRejectedValueOnce(new Error("smtp down"));

    const result = await sendNotification({
      shopId: "shop_1",
      template: "payment_failed_2",
      email: "anna@example.com",
      vars: { cycleIndex: 7, dunning_dedupe: "case_1:EMAIL:1" },
    });

    expect(result.status).toBe("FAILED");
    expect(result.directEmailSent).toBe(false);
    const rows = loggedRows();
    expect(rows.some((r) => r.status === "SENT")).toBe(false);
    const failed = rows.find((r) => r.status === "FAILED");
    expect(failed?.error).toContain("smtp down");
  });

  it("sends a critical metric template (threeds_action) exactly once, with dedupe vars", async () => {
    const result = await sendNotification({
      shopId: "shop_1",
      template: "threeds_action",
      email: "anna@example.com",
      vars: { cycleIndex: 7, dunning_dedupe: "case_1:3DS:0" },
    });

    expect(result.status).toBe("SENT");
    // Critical path only — the fallback branch must not double-send.
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    const emailRow = rowFor("EMAIL");
    expect(emailRow?.payload).toMatchObject({
      vars: { dunning_dedupe: "case_1:3DS:0" },
    });
  });

  it("never persists otp_code vars in NotificationLog (codes stay out of the DB)", async () => {
    const result = await sendNotification({
      shopId: "shop_1",
      template: "otp_code",
      email: "anna@example.com",
      vars: { code: "123456", minutes: 10 },
    });

    expect(result.status).toBe("SENT");
    const emailRow = rowFor("EMAIL");
    expect(emailRow?.status).toBe("SENT");
    expect(
      (emailRow?.payload as Record<string, unknown>).vars,
    ).toBeUndefined();
  });
});

describe("sendNotification with the key configured", () => {
  it("routes through the outbox exactly as before — no direct email for lifecycle mail", async () => {
    mocks.isKlaviyoConfigured.mockReturnValue(true);

    const result = await sendNotification({
      shopId: "shop_1",
      template: "upcoming_order",
      email: "anna@example.com",
      vars: { cycleIndex: 4 },
    });

    expect(result).toEqual({
      status: "SENT",
      klaviyoEnqueued: true,
      directEmailSent: false,
    });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(rowFor("KLAVIYO_EVENT")?.status).toBe("SENT");
  });
});
