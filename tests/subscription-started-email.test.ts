import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `subscription_started` welcome email (v1.28.0, P4.5 template / P5.2 entry
 * point) — app/lib/notifications/subscription-started.server.ts driving the
 * REAL sendNotification over mocked seams (tests/klaviyo-unconfigured-
 * fallback.test.ts pattern).
 *
 * Pins:
 *  - sent ONCE per contract: a prior SENT/SUPPRESSED row → already_sent, no
 *    second delivery; FAILED rows do not block; SUPPRESSED(foreign_contract)
 *    — the router's ownership gate on a mirror that landed UNKNOWN — is the
 *    one non-final reason (the sync heal re-invokes and the welcome goes out);
 *  - never for imports/backfills: no originOrderId → refused before the
 *    router (no log row, no metric); a contract.imported event refuses too;
 *  - vars are pre-composed (product / product_multi, first_order_line,
 *    next_line with the estimate amount, changes_line from the sweep's
 *    cut-off, support_line from the P5.1 resolver, cta_url) and the English
 *    body renders placeholder-free — also when next date / support email are
 *    missing (lines collapse to "");
 *  - Klaviyo-first: with a key the enqueue rides the CANONICAL metric
 *    "Cellexia Subscription Started" with cellexia_send "true" + content;
 *    without a key it falls back to direct SMTP;
 *  - SETUP launch mode suppresses (reason setup_mode) like every customer
 *    send; template registry/catalog/preview facts.
 */

const mocks = vi.hoisted(() => ({
  notificationLogCreate: vi.fn(
    async (_args: { data: Record<string, unknown> }): Promise<unknown> => ({}),
  ),
  notificationLogFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  notificationLogFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  subscriberEventFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  contractFindUnique: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  shopFindUnique: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  isSetupMode: vi.fn(async (): Promise<boolean> => false),
  isKlaviyoConfigured: vi.fn((): boolean => false),
  getSetting: vi.fn(async (_shopId: string, _key: string): Promise<unknown> => ({})),
  enqueue: vi.fn(async (_shopId: string, _input: unknown): Promise<{ id: string } | null> => ({ id: "obx_1" })),
  logEvent: vi.fn(async (_input: unknown): Promise<void> => {}),
  sendEmail: vi.fn(
    async (_mail: { to: string; subject: string; html: string }): Promise<void> => {},
  ),
  buildPortalUrl: vi.fn(
    async (_shopId: string, _path?: string): Promise<string> =>
      "https://www.cellexia.example/apps/cellexia-subs/",
  ),
  estimateNextCharge: vi.fn(async (): Promise<unknown> => ({ totalCents: 13200 })),
  getSupportChannels: vi.fn(async (): Promise<unknown> => ({ email: "hello@cellexia.example" })),
}));

vi.mock("~/db.server", () => ({
  default: {
    notificationLog: {
      create: mocks.notificationLogCreate,
      findFirst: mocks.notificationLogFindFirst,
      findMany: mocks.notificationLogFindMany,
    },
    subscriberEvent: { findFirst: mocks.subscriberEventFindFirst },
    subscriptionContract: { findUnique: mocks.contractFindUnique },
    shop: { findUnique: mocks.shopFindUnique },
  },
}));
vi.mock("~/lib/launch/launch.server", () => ({ isSetupMode: mocks.isSetupMode }));
vi.mock("~/lib/klaviyo/client.server", () => ({
  isKlaviyoConfigured: mocks.isKlaviyoConfigured,
}));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));
vi.mock("~/lib/klaviyo/outbox.server", () => ({ enqueue: mocks.enqueue }));
vi.mock("~/lib/klaviyo/events-map.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/klaviyo/events-map.server")>();
  return {
    ...actual,
    contractProfileAttrs: vi.fn(() => ({})),
    contractSnapshotProperties: vi.fn(async () => ({
      portal_url: "https://www.cellexia.example/apps/cellexia-subs/",
    })),
  };
});
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildPortalUrl: mocks.buildPortalUrl,
  buildActionLinkBundle: vi.fn(async () => ({})),
}));
vi.mock("~/lib/notifications/mailer.server", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("~/lib/billing/estimate.server", () => ({
  estimateNextCharge: mocks.estimateNextCharge,
}));
// reminders.server pulls the Shopify client graph — keep only the cut-off
// helper, on the REAL timing helper, so the pinned label is the sweep's.
vi.mock("~/lib/billing/reminders.server", async () => {
  const timing = await vi.importActual<typeof import("~/lib/billing/timing.server")>(
    "~/lib/billing/timing.server",
  );
  const dates = await vi.importActual<typeof import("~/lib/dates.server")>(
    "~/lib/dates.server",
  );
  return {
    reminderCutoffVars: (
      _locale: string | null,
      nextBillingDate: Date,
      t: { tz: string; chargeHourLocal: number },
    ) => {
      const cutoff = timing.editCutoffSync(nextBillingDate, t);
      const label = `${dates.formatShopDate(cutoff, t.tz)}, ${dates.formatShopTime(cutoff, t.tz)}`;
      return {
        edit_cutoff: label,
        edit_cutoff_iso: cutoff.toISOString(),
        edit_cutoff_line: `You can make changes until ${label}.`,
      };
    },
  };
});
vi.mock("~/lib/support/channels.server", () => ({
  getSupportChannels: mocks.getSupportChannels,
}));

import { maybeSendSubscriptionStarted } from "~/lib/notifications/subscription-started.server";
import { TEMPLATES } from "~/lib/notifications/templates.server";
import { EMAIL_CATALOG } from "~/lib/notifications/catalog.server";
import { previewSampleVars } from "~/lib/notifications/preview.server";
import { SETUP_ALLOWED_TEMPLATES } from "~/lib/notifications/send.server";
import { metricForEventType } from "~/lib/klaviyo/events-map.server";

const PLACEHOLDER = /\{[a-z0-9_]+\}/i;

function contract(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: "gid://shopify/SubscriptionContract/1",
    customerId: "gid://shopify/Customer/1",
    email: "anna@example.com",
    phone: null,
    locale: "en",
    status: "ACTIVE",
    ownership: "OURS",
    isDemo: false,
    ordersCount: 1,
    intervalWeeks: 8,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 8,
    currencyCode: "CHF",
    deliveryPriceCents: 0,
    nextBillingDate: new Date("2026-09-12T00:00:00Z") as Date | null,
    originOrderId: "gid://shopify/Order/2148" as string | null,
    originOrderName: "#2148" as string | null,
    firstName: "Anna",
    lastName: null,
    churnRiskScore: null,
    lines: [
      {
        id: "l1",
        variantId: "gid://shopify/ProductVariant/1",
        title: "Cellexia Renewal Serum",
        variantTitle: null,
        quantity: 1,
        currentPriceCents: 6400,
        isGift: false,
        isOneTimeAddon: false,
      },
    ],
    ...over,
  };
}

type LogRow = { data: Record<string, unknown> };
function loggedRows(): Record<string, unknown>[] {
  return mocks.notificationLogCreate.mock.calls.map((c) => (c[0] as LogRow).data);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.isSetupMode.mockResolvedValue(false);
  mocks.isKlaviyoConfigured.mockReturnValue(false);
  mocks.notificationLogFindFirst.mockResolvedValue(null);
  mocks.notificationLogFindMany.mockResolvedValue([]);
  mocks.subscriberEventFindFirst.mockResolvedValue(null);
  mocks.contractFindUnique.mockResolvedValue(contract());
  mocks.shopFindUnique.mockResolvedValue({
    id: "shop_1",
    ianaTimezone: "Europe/Zurich",
    contactEmail: "owner@cellexia.example",
  });
  mocks.estimateNextCharge.mockResolvedValue({ totalCents: 13200 });
  mocks.getSupportChannels.mockResolvedValue({ email: "hello@cellexia.example" });
  mocks.getSetting.mockImplementation(async (_shopId: string, key: string) => {
    if (key === "notifications") return { channels: { email: true, sms: true } };
    if (key === "billing") return { chargeHourLocal: 6 };
    if (key === "emails") return { templates: {} };
    return {};
  });
});

describe("registry facts", () => {
  it("rides the canonical contract.created metric — no duplicate 'started' metric", () => {
    expect(TEMPLATES.subscription_started.klaviyoMetric).toBe(
      metricForEventType("contract.created"),
    );
    expect(TEMPLATES.subscription_started.klaviyoMetric).toBe(
      "Cellexia Subscription Started",
    );
    expect(TEMPLATES.subscription_started.channel).toBe("EMAIL");
    expect(TEMPLATES.subscription_started.critical).toBe(false);
    expect(TEMPLATES.subscription_started.ctaLabelKey).toBe("email.cta.manage_mine");
  });

  it("is catalogued (lifecycle, customizable, disableable) and NOT setup-allowed", () => {
    const entry = EMAIL_CATALOG.subscription_started;
    expect(entry.group).toBe("lifecycle");
    expect(entry.customizable).toBe(true);
    expect(entry.disableable).toBe(true);
    expect(entry.trigger).toMatch(/imported/i);
    expect(SETUP_ALLOWED_TEMPLATES.has("subscription_started")).toBe(false);
  });

  it("preview samples cover every placeholder the body references", () => {
    const vars = previewSampleVars("subscription_started");
    for (const key of [
      "product",
      "first_order_line",
      "next_line",
      "changes_line",
      "support_line",
      "portal_url",
      "cta_url",
    ]) {
      expect(vars[key], key).toBeDefined();
    }
  });
});

describe("maybeSendSubscriptionStarted — genuinely new contracts only", () => {
  it("sends once via SMTP (Klaviyo unconfigured) with pre-composed vars, then never again", async () => {
    const outcome = await maybeSendSubscriptionStarted("shop_1", "c_1");
    expect(outcome).toBe("sent");
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    const mail = mocks.sendEmail.mock.calls[0][0];
    expect(mail.to).toBe("anna@example.com");
    expect(mail.subject).toBe(
      "Welcome — your Cellexia Renewal Serum subscription is set",
    );
    expect(mail.subject).not.toMatch(PLACEHOLDER);
    expect(mail.html).not.toMatch(PLACEHOLDER);
    // What happens next: first order placed (origin order exists)…
    expect(mail.html).toContain("Your first order #2148 is placed and being prepared.");
    // …next charge with the estimate amount, date + cadence…
    expect(mail.html).toContain("about CHF");
    expect(mail.html).toContain("132.00");
    expect(mail.html).toContain("September 12, 2026");
    expect(mail.html).toContain("every 8 weeks");
    // …the sweep's cut-off (chargeHourLocal 6, Europe/Zurich → 06:00)…
    expect(mail.html).toMatch(/You can change, skip or delay it until September 12, 2026, 6:00\s?AM\./);
    // …how to make changes + support + CTA.
    expect(mail.html).toContain("https://www.cellexia.example/apps/cellexia-subs/");
    expect(mail.html).toContain("Write to us at hello@cellexia.example");
    expect(mail.html).toContain("Manage my subscription");

    // The router's SENT row carries the vars (SMTP fallback contract).
    const sent = loggedRows().find((r) => r.status === "SENT");
    expect(sent?.template).toBe("subscription_started");
    const vars = (sent?.payload as { vars: Record<string, unknown> }).vars;
    expect(vars.product).toBe("Cellexia Renewal Serum");
    expect(vars.order_name).toBe("#2148");
    expect(vars.edit_cutoff_iso).toBe("2026-09-12T04:00:00.000Z");
    expect(vars.next_date_iso).toBe("2026-09-12T00:00:00.000Z");
    expect(vars.support_email).toBe("hello@cellexia.example");
    expect(vars.cta_url).toBe("https://www.cellexia.example/apps/cellexia-subs/");

    // Second call (webhook replay / catch-up): a prior SENT row → no send.
    mocks.notificationLogFindMany.mockResolvedValue([{ status: "SENT", payload: {} }]);
    mocks.sendEmail.mockClear();
    expect(await maybeSendSubscriptionStarted("shop_1", "c_1")).toBe("already_sent");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    // The dedupe query is by contract + template, SENT or SUPPRESSED.
    const where = (mocks.notificationLogFindMany.mock.calls.at(-1)?.[0] as {
      where: Record<string, unknown>;
    }).where;
    expect(where.contractId).toBe("c_1");
    expect(where.template).toBe("subscription_started");
    expect(where.status).toEqual({ in: ["SENT", "SUPPRESSED"] });
  });

  it("dedupe: SUPPRESSED(setup_mode / disabled / demo) is final; SUPPRESSED(foreign_contract) is NOT — the UNKNOWN→OURS heal may still welcome", async () => {
    // Final suppressions block.
    for (const reason of ["setup_mode", "disabled", "demo_contract"]) {
      mocks.notificationLogFindMany.mockResolvedValue([
        { status: "SUPPRESSED", payload: { reason } },
      ]);
      expect(await maybeSendSubscriptionStarted("shop_1", "c_1"), reason).toBe("already_sent");
    }
    // A SUPPRESSED row without any payload (legacy shape) also blocks.
    mocks.notificationLogFindMany.mockResolvedValue([{ status: "SUPPRESSED", payload: null }]);
    expect(await maybeSendSubscriptionStarted("shop_1", "c_1")).toBe("already_sent");
    expect(mocks.sendEmail).not.toHaveBeenCalled();

    // The router's ownership gate (mirror landed UNKNOWN at create) is the
    // ONE non-final reason: once ownership is OURS the welcome goes out.
    mocks.notificationLogFindMany.mockResolvedValue([
      { status: "SUPPRESSED", payload: { reason: "foreign_contract", ownership: "UNKNOWN" } },
    ]);
    expect(await maybeSendSubscriptionStarted("shop_1", "c_1")).toBe("sent");
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);

    // …but a SENT row beside it still wins (never twice).
    mocks.sendEmail.mockClear();
    mocks.notificationLogFindMany.mockResolvedValue([
      { status: "SUPPRESSED", payload: { reason: "foreign_contract" } },
      { status: "SENT", payload: {} },
    ]);
    expect(await maybeSendSubscriptionStarted("shop_1", "c_1")).toBe("already_sent");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("Klaviyo-first when configured: canonical metric, cellexia_send true, rendered content, no SMTP", async () => {
    mocks.isKlaviyoConfigured.mockReturnValue(true);
    expect(await maybeSendSubscriptionStarted("shop_1", "c_1")).toBe("sent");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const [, input] = mocks.enqueue.mock.calls[0] as [string, {
      eventName: string;
      email: string | null;
      properties: Record<string, unknown>;
    }];
    expect(input.eventName).toBe("Cellexia Subscription Started");
    expect(input.email).toBe("anna@example.com");
    expect(input.properties.template).toBe("subscription_started");
    expect(input.properties.cellexia_send).toBe("true");
    expect(String(input.properties.content_subject)).toContain("Welcome");
    expect(String(input.properties.content_html)).toContain("#2148");
    expect(input.properties.product).toBe("Cellexia Renewal Serum");
  });

  it("refuses imported/backfilled contracts (no origin order) BEFORE the router — no row, no metric", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      contract({ originOrderId: null, originOrderName: null }),
    );
    expect(await maybeSendSubscriptionStarted("shop_1", "c_1")).toBe("not_new_contract");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.notificationLogCreate).not.toHaveBeenCalled();
  });

  it("refuses a contract with a contract.imported event even when an origin order is mirrored", async () => {
    mocks.subscriberEventFindFirst.mockResolvedValue({ id: "ev_import" });
    expect(await maybeSendSubscriptionStarted("shop_1", "c_1")).toBe("not_new_contract");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.notificationLogCreate).not.toHaveBeenCalled();
    const where = (mocks.subscriberEventFindFirst.mock.calls[0][0] as {
      where: Record<string, unknown>;
    }).where;
    expect(where.type).toBe("contract.imported");
    expect(where.contractId).toBe("c_1");
  });

  it("SETUP launch mode suppresses like every customer send (reason setup_mode)", async () => {
    mocks.isSetupMode.mockResolvedValue(true);
    expect(await maybeSendSubscriptionStarted("shop_1", "c_1")).toBe("suppressed");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    const row = loggedRows()[0];
    expect(row.status).toBe("SUPPRESSED");
    expect((row.payload as { reason: string }).reason).toBe("setup_mode");
  });

  it("missing facts collapse their lines instead of inventing them — still placeholder-free", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      contract({
        nextBillingDate: null,
        originOrderName: null,
        lines: [
          {
            id: "l1",
            variantId: "v1",
            title: "Cellexia Renewal Serum",
            quantity: 1,
            currentPriceCents: 6400,
            isGift: false,
            isOneTimeAddon: false,
          },
          {
            id: "l2",
            variantId: "v2",
            title: "Cellexia Night Cream",
            quantity: 1,
            currentPriceCents: 6800,
            isGift: false,
            isOneTimeAddon: false,
          },
          {
            id: "l3",
            variantId: "v3",
            title: "Free travel kit",
            quantity: 1,
            currentPriceCents: 0,
            isGift: true,
            isOneTimeAddon: false,
          },
        ],
      }),
    );
    mocks.getSupportChannels.mockResolvedValue({ email: null });
    expect(await maybeSendSubscriptionStarted("shop_1", "c_1")).toBe("sent");
    const mail = mocks.sendEmail.mock.calls[0][0];
    expect(mail.subject).toBe(
      "Welcome — your Cellexia Renewal Serum and 1 more subscription is set",
    );
    expect(mail.html).not.toMatch(PLACEHOLDER);
    expect(mail.html).toContain("Your first order is placed and being prepared.");
    expect(mail.html).not.toContain("scheduled for");
    expect(mail.html).not.toContain("Write to us");
    expect(mail.html).not.toContain("Free travel kit"); // gifts never name the subscription
    const sent = loggedRows().find((r) => r.status === "SENT");
    const vars = (sent?.payload as { vars: Record<string, unknown> }).vars;
    expect(vars.next_line).toBe("");
    expect(vars.changes_line).toBe("");
    expect(vars.support_line).toBe("");
    expect(mocks.estimateNextCharge).not.toHaveBeenCalled();
  });

  it("estimate/support failures degrade the line, never the send; a thrown read never escapes", async () => {
    mocks.estimateNextCharge.mockRejectedValue(new Error("boom"));
    mocks.getSupportChannels.mockRejectedValue(new Error("boom"));
    expect(await maybeSendSubscriptionStarted("shop_1", "c_1")).toBe("sent");
    const mail = mocks.sendEmail.mock.calls[0][0];
    expect(mail.html).not.toMatch(PLACEHOLDER);
    expect(mail.html).toContain("Your next order is scheduled for September 12, 2026 (every 8 weeks).");

    mocks.contractFindUnique.mockRejectedValue(new Error("db down"));
    await expect(maybeSendSubscriptionStarted("shop_1", "c_1")).resolves.toBe("error");
  });

  it("unknown contract / foreign shop → no_contract", async () => {
    mocks.contractFindUnique.mockResolvedValue(null);
    expect(await maybeSendSubscriptionStarted("shop_1", "c_1")).toBe("no_contract");
    mocks.contractFindUnique.mockResolvedValue(contract({ shopId: "other" }));
    expect(await maybeSendSubscriptionStarted("shop_1", "c_1")).toBe("no_contract");
    expect(mocks.notificationLogCreate).not.toHaveBeenCalled();
  });
});
