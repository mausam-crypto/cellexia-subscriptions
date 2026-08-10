import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Launch-mode (install-dark) tests: the SETUP default, the job-runner gate
 * list, and the notification setup allowlist. Everything DB-shaped is mocked
 * (klaviyo-map.test.ts pattern) — the suite never touches a database:
 *
 *  - ~/db.server → NotificationLog capture + contract/shop lookups
 *  - ~/shopify.server, ~/lib/shop/install.server → inert stubs so importing
 *    the runner registry never boots the Shopify app or Prisma
 *  - ~/lib/launch/launch.server → isSetupMode toggle per test
 *  - settings / outbox / builder / events-map / mailer / log → capture stubs
 */

const mocks = vi.hoisted(() => ({
  notificationLogCreate: vi.fn(
    async (_args: { data: Record<string, unknown> }): Promise<unknown> => ({}),
  ),
  contractFindUnique: vi.fn(async (): Promise<unknown> => null),
  shopFindUnique: vi.fn(async (): Promise<unknown> => null),
  isSetupMode: vi.fn(async (_shopId: string): Promise<boolean> => true),
  getSetting: vi.fn(
    async (_shopId: string, _key: string): Promise<unknown> => ({}),
  ),
  enqueue: vi.fn(
    async (
      _shopId: string,
      _event: { eventName: string; email: string | null },
    ): Promise<{ id: string } | null> => ({ id: "obx_1" }),
  ),
  logEvent: vi.fn(async (): Promise<void> => {}),
  sendEmail: vi.fn(
    async (_mail: { to: string; subject: string; html: string }): Promise<void> => {},
  ),
  buildPortalUrl: vi.fn(
    async (): Promise<string> => "https://www.cellexia.example/apps/cellexia-subs/",
  ),
  buildActionLinkBundle: vi.fn(
    async (): Promise<Record<string, string>> => ({}),
  ),
}));

vi.mock("~/db.server", () => ({
  default: {
    notificationLog: { create: mocks.notificationLogCreate },
    subscriptionContract: { findUnique: mocks.contractFindUnique },
    shop: { findUnique: mocks.shopFindUnique },
  },
}));

// The runner registry imports these at module load; stub them so the import
// never boots the real Shopify app object (which requires env + Prisma).
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(),
}));

vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
  requireShop: vi.fn(),
}));

vi.mock("~/lib/launch/launch.server", () => ({
  isSetupMode: mocks.isSetupMode,
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: mocks.getSetting,
}));

vi.mock("~/lib/klaviyo/outbox.server", () => ({
  enqueue: mocks.enqueue,
}));

// This suite is about the SETUP gate, not the Klaviyo-unconfigured fallback
// (tests/klaviyo-unconfigured-fallback.test.ts) — pin the key as present so
// the LIVE path exercises the outbox as before.
vi.mock("~/lib/klaviyo/client.server", () => ({
  isKlaviyoConfigured: () => true,
}));

vi.mock("~/lib/klaviyo/events-map.server", () => ({
  contractProfileAttrs: vi.fn(() => ({})),
  contractSnapshotProperties: vi.fn(async () => ({})),
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

import { defaultFor, settingsSchemas } from "~/lib/settings/registry.server";
import { JOB_NAMES, SETUP_GATED_JOB_NAMES } from "~/lib/jobs/runner.server";
import {
  sendNotification,
  SETUP_ALLOWED_TEMPLATES,
} from "~/lib/notifications/send.server";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isSetupMode.mockResolvedValue(true); // SETUP unless a test says otherwise
  mocks.contractFindUnique.mockResolvedValue(null);
  mocks.shopFindUnique.mockResolvedValue({
    id: "shop_1",
    ianaTimezone: "Europe/London",
    contactEmail: "owner@cellexia.example",
  });
  mocks.getSetting.mockImplementation(async (_shopId: string, key: string) => {
    if (key === "alerts") return { ...defaultFor("alerts"), emailTo: ["ops@cellexia.example"] };
    return defaultFor(key as Parameters<typeof defaultFor>[0]);
  });
});

// ── Launch settings default ──────────────────────────────────────────────────

describe("launch settings default", () => {
  it("defaults to SETUP with the whole checklist unticked", () => {
    expect(defaultFor("launch")).toEqual({
      mode: "SETUP",
      wentLiveAt: null,
      confirmedThemeBlock: false,
      confirmedKlaviyo: false,
      previewedStorefront: false,
      previewedPortal: false,
    });
  });

  it("an absent stored value parses to the SETUP default (fresh install is dark)", () => {
    const parsed = settingsSchemas.launch.parse(undefined);
    expect(parsed.mode).toBe("SETUP");
    expect(parsed.wentLiveAt).toBeNull();
  });

  it("a corrupted stored value falls back to SETUP, never LIVE (fail dark)", () => {
    const junk = settingsSchemas.launch.safeParse({ mode: "LIVE" }); // missing fields
    expect(junk.success).toBe(false);
    expect(defaultFor("launch").mode).toBe("SETUP");
  });
});

// ── Job-runner SETUP gate ────────────────────────────────────────────────────

describe("job runner SETUP gate list", () => {
  const EXPECTED_GATED = [
    "billing_run",
    "dunning_run",
    "reminders_run",
    "pause_autoresume",
    "gifts_run",
    "winback_run",
    "consolidation_run",
    "pre_expiry_notices",
    "lifecycle_run",
  ];

  const EXPECTED_UNGATED = [
    "rollup_run",
    "alerts_run",
    "klaviyo_flush",
    "stale_attempt_sweep",
    // Recovery plumbing like stale_attempt_sweep: re-drives half-settled
    // attempts whose 200-answered webhook has no retry train left. In SETUP
    // there are no billed attempts, so the sweep is a no-op — and gating it
    // would leave any pre-upgrade residue stranded until go-live.
    "settlement_redrive",
  ];

  it("gates exactly the customer-facing jobs", () => {
    expect([...SETUP_GATED_JOB_NAMES].sort()).toEqual(
      [...EXPECTED_GATED].sort(),
    );
  });

  it("every gated name is a registered job", () => {
    for (const name of SETUP_GATED_JOB_NAMES) {
      expect(JOB_NAMES, `gated job "${name}" must exist`).toContain(name);
    }
  });

  it("analytics / alerts / outbox / sweep plumbing stays ungated", () => {
    for (const name of EXPECTED_UNGATED) {
      expect(JOB_NAMES, `job "${name}" must exist`).toContain(name);
      expect(
        SETUP_GATED_JOB_NAMES,
        `job "${name}" must keep running in SETUP`,
      ).not.toContain(name);
    }
  });
});

// ── Notification setup allowlist ─────────────────────────────────────────────

describe("notification SETUP allowlist (pure predicate)", () => {
  it("allows exactly otp_code, admin_alert and import_summary", () => {
    expect(SETUP_ALLOWED_TEMPLATES.has("otp_code")).toBe(true);
    expect(SETUP_ALLOWED_TEMPLATES.has("admin_alert")).toBe(true);
    expect(SETUP_ALLOWED_TEMPLATES.has("import_summary")).toBe(true);
    expect(SETUP_ALLOWED_TEMPLATES.size).toBe(3);
  });

  it("does not allow customer-facing templates", () => {
    expect(SETUP_ALLOWED_TEMPLATES.has("upcoming_order")).toBe(false);
    expect(SETUP_ALLOWED_TEMPLATES.has("payment_failed_1")).toBe(false);
    expect(SETUP_ALLOWED_TEMPLATES.has("winback_discount")).toBe(false);
  });
});

describe("sendNotification in SETUP mode", () => {
  it("suppresses upcoming_order and logs SUPPRESSED with reason setup_mode", async () => {
    const result = await sendNotification({
      shopId: "shop_1",
      template: "upcoming_order",
      email: "anna@example.com",
      vars: { cycleIndex: 4 },
    });

    expect(result).toEqual({
      status: "SUPPRESSED",
      klaviyoEnqueued: false,
      directEmailSent: false,
    });
    expect(mocks.isSetupMode).toHaveBeenCalledWith("shop_1");
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();

    expect(mocks.notificationLogCreate).toHaveBeenCalledTimes(1);
    const [row] = mocks.notificationLogCreate.mock.calls[0]!;
    expect(row.data.template).toBe("upcoming_order");
    expect(row.data.status).toBe("SUPPRESSED");
    expect(row.data.payload).toEqual({ cycleIndex: 4, reason: "setup_mode" });
  });

  it("otp_code still sends via direct SMTP without even checking launch mode", async () => {
    const result = await sendNotification({
      shopId: "shop_1",
      template: "otp_code",
      email: "anna@example.com",
      vars: { code: "123456", minutes: 10 },
    });

    expect(result.status).toBe("SENT");
    expect(result.directEmailSent).toBe(true);
    expect(result.klaviyoEnqueued).toBe(false); // OTP never routes to Klaviyo
    expect(mocks.isSetupMode).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const [mail] = mocks.sendEmail.mock.calls[0]!;
    expect(mail.to).toBe("anna@example.com");
  });

  it("admin_alert resolves merchant recipients from settings and sends", async () => {
    const result = await sendNotification({
      shopId: "shop_1",
      template: "admin_alert",
      vars: { subject: "Billing failure spike", body: "3 failures in 15m" },
    });

    expect(result.status).toBe("SENT");
    expect(result.directEmailSent).toBe(true);
    expect(mocks.isSetupMode).not.toHaveBeenCalled();
    const [mail] = mocks.sendEmail.mock.calls[0]!;
    expect(mail.to).toBe("ops@cellexia.example");
  });

  it("import_summary sends to the given merchant address", async () => {
    const result = await sendNotification({
      shopId: "shop_1",
      template: "import_summary",
      email: "merchant@cellexia.example",
      vars: { imported: 120, failed: 2 },
    });

    expect(result.status).toBe("SENT");
    expect(result.directEmailSent).toBe(true);
    expect(mocks.isSetupMode).not.toHaveBeenCalled();
  });
});

describe("sendNotification once LIVE", () => {
  it("upcoming_order goes through to the Klaviyo outbox again", async () => {
    mocks.isSetupMode.mockResolvedValue(false);

    const result = await sendNotification({
      shopId: "shop_1",
      template: "upcoming_order",
      email: "anna@example.com",
      vars: { cycleIndex: 4 },
    });

    expect(mocks.isSetupMode).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("SENT");
    expect(result.klaviyoEnqueued).toBe(true);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const [shopId, event] = mocks.enqueue.mock.calls[0]!;
    expect(shopId).toBe("shop_1");
    expect(event.eventName).toBe("Cellexia Upcoming Order");
    expect(event.email).toBe("anna@example.com");
  });
});
