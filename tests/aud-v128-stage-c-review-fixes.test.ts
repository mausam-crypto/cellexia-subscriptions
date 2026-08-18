import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * v1.28.0 Stage C adversarial-review fixes — pins.
 *
 *  1. Cancel-flow SUPPORT/EDUCATION saves share the portal's support budget:
 *     `supportBudgetExceeded` (request.server.ts) is insert-then-count on
 *     the same portal.mutation_attempt rows POST /api/support uses, applies
 *     BOTH portal.mutationsPerHour and support.requestsPerHour, and the
 *     cancel route answers 429 (no acceptSave, nothing recorded) when it is
 *     exhausted; other save kinds never consult it.
 *  2. Support settings are format-refined at save time with the resolver's
 *     rules — a value the resolver would drop to null is rejected (never a
 *     silent reroute to Shop.contactEmail / a silently hidden button).
 *  3. `support.requested` is enqueued to Klaviyo with dedupe OFF (two
 *     distinct requests inside 120 s both arrive); every other mapped event
 *     keeps the default dedupe.
 *  4. Welcome-email heal: settings.notifications.welcomeHealMaxDays
 *     (default 7, 0..30) + the sync's UNKNOWN→billable heal block re-invokes
 *     maybeSendSubscriptionStarted (source pin; the dedupe half is pinned in
 *     tests/subscription-started-email.test.ts).
 *  5. Docs: KLAVIYO_SETUP.md carries the "Cellexia Support Requested" row
 *     with the REAL camelCase property names, and the Reply-To
 *     creation-only caveat; the events-map comment no longer promises
 *     snake_case keys.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const src = (rel: string) => readFileSync(`${ROOT}${rel}`, "utf8");

const mocks = vi.hoisted(() => ({
  settings: {
    portal: { mutationsPerHour: 30 } as Record<string, unknown>,
    support: { requestsPerHour: 3 } as Record<string, unknown>,
  },
  count: vi.fn(async (_args?: unknown): Promise<number> => 1),
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  logEventOrThrow: vi.fn(async (_e: unknown): Promise<void> => {}),
  enqueue: vi.fn(
    async (_shopId: string, _input: unknown, _options?: unknown): Promise<{ id: string } | null> => ({
      id: "obx",
    }),
  ),
  // Cancel route seams.
  ctx: {} as Record<string, unknown>,
  csrfOk: vi.fn((): boolean => true),
  getActiveSession: vi.fn(async (): Promise<unknown> => ({ id: "cs_1", reason: "SHIPPING_ISSUES" })),
  acceptSave: vi.fn(async (): Promise<unknown> => ({})),
  supportBudgetExceeded: vi.fn(async (_i: unknown): Promise<boolean> => false),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriberEvent: {
      count: mocks.count,
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    shop: { findUnique: vi.fn(async () => null) },
    subscriptionContract: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    billingAttempt: { findMany: vi.fn(async () => []) },
    klaviyoOutbox: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "portal") return mocks.settings.portal;
    if (key === "support") return mocks.settings.support;
    return {};
  }),
}));
vi.mock("~/lib/events/log.server", () => ({
  logEvent: mocks.logEvent,
  logEventOrThrow: mocks.logEventOrThrow,
}));
vi.mock("~/lib/klaviyo/outbox.server", () => ({ enqueue: mocks.enqueue }));
vi.mock("~/shopify.server", () => ({
  authenticate: { public: { appProxy: vi.fn() } },
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/graphql/index.server", () => ({}));
vi.mock("~/lib/launch/launch.server", () => ({
  isSetupMode: vi.fn(async (): Promise<boolean> => false),
}));
vi.mock("~/lib/graphql/client.server", () => ({ gql: vi.fn(async () => ({})) }));
vi.mock("~/lib/cancel/portal.server", () => ({
  requireCancelContext: vi.fn(async (): Promise<unknown> => mocks.ctx),
  csrfOk: mocks.csrfOk,
  renderCancelPage: vi.fn(() => new Response("page", { status: 200 })),
}));
vi.mock("~/lib/cancel/engine.server", () => ({
  acceptFinalOffer: vi.fn(),
  acceptSave: mocks.acceptSave,
  completeCancel: vi.fn(),
  eligibleForFinalOffer: vi.fn(),
  getActiveSession: mocks.getActiveSession,
  getLatestSavedSession: vi.fn(),
  getSavesForReason: vi.fn(),
  hasSeenFinalOffer: vi.fn(),
  recordFinalOfferShown: vi.fn(),
  recordReason: vi.fn(),
  recordSaveShown: vi.fn(),
  startCancelSession: vi.fn(),
}));
vi.mock("~/lib/cancel/summary.server", () => ({ buildRetentionSummary: vi.fn() }));
vi.mock("~/lib/billing/stacking.server", () => ({ clampGrantPercentForContract: vi.fn() }));
vi.mock("~/lib/support/request.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/support/request.server")>();
  return { ...actual, supportBudgetExceeded: mocks.supportBudgetExceeded };
});

import { action as cancelAction } from "~/routes/proxy.cancel.$id.$step";
import { settingsSchemas } from "~/lib/settings/registry.server";
import {
  normalizeChatUrl,
  normalizeSupportEmail,
  normalizeWhatsapp,
} from "~/lib/support/channels.server";
import {
  NO_DEDUPE_EVENT_TYPES,
  enqueueKlaviyoForEvent,
} from "~/lib/klaviyo/events-map.server";

// The REAL supportBudgetExceeded (the route above sees the mocked one).
const realRequest = await vi.importActual<typeof import("~/lib/support/request.server")>(
  "~/lib/support/request.server",
);

function cancelCtx() {
  return {
    shop: { id: "shop_1", domain: "cellexia.myshopify.com", ianaTimezone: "Europe/Zurich" },
    contract: { id: "c_1", status: "ACTIVE", currencyCode: "CHF", lines: [] },
    portalSession: {
      id: "ps_1",
      shopId: "shop_1",
      customerId: "gid://shopify/Customer/1",
      email: "sub@example.com",
      isPreview: false,
      csrfToken: "csrf",
      previewToken: null,
    },
    locale: "en",
    liquid: (body: string, init?: ResponseInit) => new Response(body, init),
    previewToast: null,
  };
}

async function postSaves(fields: Record<string, string>): Promise<Response> {
  const form = new URLSearchParams({ _csrf: "csrf", ...fields });
  return (await cancelAction({
    request: new Request("https://cellexialabs.com/apps/cellexia-subs/cancel/c_1/saves", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    params: { id: "c_1", step: "saves" },
    context: {},
  } as never)) as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.portal = { mutationsPerHour: 30 };
  mocks.settings.support = { requestsPerHour: 3 };
  mocks.count.mockResolvedValue(1);
  mocks.supportBudgetExceeded.mockResolvedValue(false);
  mocks.getActiveSession.mockResolvedValue({ id: "cs_1", reason: "SHIPPING_ISSUES" });
  Object.keys(mocks.ctx).forEach((k) => delete mocks.ctx[k]);
  Object.assign(mocks.ctx, cancelCtx());
});

// ── 1. Shared support budget ─────────────────────────────────────────────────

describe("supportBudgetExceeded — the ONE support budget for every surface", () => {
  const input = {
    shopId: "shop_1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
  };

  it("insert-then-count: records a portal.mutation_attempt {action: support} row FIRST, then counts both budgets", async () => {
    mocks.count.mockResolvedValue(1);
    expect(await realRequest.supportBudgetExceeded({ ...input, recordAttempt: true })).toBe(false);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "portal.mutation_attempt",
        source: "CUSTOMER_PORTAL",
        customerId: input.customerId,
        payload: { action: "support" },
      }),
    );
    // The insert precedes every count.
    const insertOrder = mocks.logEvent.mock.invocationCallOrder[0];
    for (const order of mocks.count.mock.invocationCallOrder) {
      expect(order).toBeGreaterThan(insertOrder);
    }
    // Two counts: the general one and the support-scoped one (payload path).
    const wheres = mocks.count.mock.calls.map((c) => (c[0] as { where: Record<string, unknown> }).where);
    expect(wheres).toHaveLength(2);
    expect(wheres.every((w) => w.type === "portal.mutation_attempt" && w.source === "CUSTOMER_PORTAL")).toBe(true);
    expect(wheres.filter((w) => w.payload)).toEqual([
      expect.objectContaining({ payload: { path: ["action"], equals: "support" } }),
    ]);
  });

  it("recordAttempt:false counts without inserting (the portal dispatcher already inserted this request's row)", async () => {
    await realRequest.supportBudgetExceeded({ ...input, recordAttempt: false });
    expect(mocks.logEvent).not.toHaveBeenCalled();
    expect(mocks.count).toHaveBeenCalledTimes(2);
  });

  it("strictly greater than EITHER budget ⇒ exceeded (support.requestsPerHour is the tighter one; portal.mutationsPerHour still applies)", async () => {
    // Support-scoped count 4 > 3, general 2.
    mocks.count.mockImplementation(async (args: unknown) =>
      (args as { where: { payload?: unknown } }).where.payload ? 4 : 2,
    );
    expect(await realRequest.supportBudgetExceeded({ ...input, recordAttempt: true })).toBe(true);
    // Exactly at the budget ⇒ allowed (the count includes this attempt).
    mocks.count.mockImplementation(async (args: unknown) =>
      (args as { where: { payload?: unknown } }).where.payload ? 3 : 2,
    );
    expect(await realRequest.supportBudgetExceeded({ ...input, recordAttempt: true })).toBe(false);
    // The general portal budget alone can refuse.
    mocks.count.mockImplementation(async (args: unknown) =>
      (args as { where: { payload?: unknown } }).where.payload ? 1 : 31,
    );
    expect(await realRequest.supportBudgetExceeded({ ...input, recordAttempt: true })).toBe(true);
    // Settings raise it.
    mocks.settings.support = { requestsPerHour: 10 };
    mocks.count.mockImplementation(async (args: unknown) =>
      (args as { where: { payload?: unknown } }).where.payload ? 4 : 2,
    );
    expect(await realRequest.supportBudgetExceeded({ ...input, recordAttempt: true })).toBe(false);
  });
});

describe("cancel route — SUPPORT/EDUCATION saves are budgeted BEFORE the save is claimed", () => {
  for (const kind of ["SUPPORT", "EDUCATION"] as const) {
    it(`${kind} + message: budget consulted (recordAttempt: true, session identity); exhausted ⇒ 429, acceptSave never called`, async () => {
      mocks.supportBudgetExceeded.mockResolvedValue(true);
      const res = await postSaves({ kind, support_topic: "DELIVERY", support_message: "Two boxes late" });
      expect(res.status).toBe(429);
      expect(await res.text()).toContain("One moment");
      expect(mocks.supportBudgetExceeded).toHaveBeenCalledWith({
        shopId: "shop_1",
        customerId: "gid://shopify/Customer/1",
        email: "sub@example.com",
        recordAttempt: true,
      });
      expect(mocks.acceptSave).not.toHaveBeenCalled();
    });

    it(`${kind} + message under budget: acceptSave runs and the customer lands on /saved`, async () => {
      const res = await postSaves({ kind, support_topic: "OTHER", support_message: "Which order?" });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain("/cancel/c_1/saved");
      expect(mocks.acceptSave).toHaveBeenCalledWith(
        "cs_1",
        kind,
        expect.objectContaining({ support: { topic: "OTHER", message: "Which order?" } }),
      );
    });
  }

  it("a SUPPORT save WITHOUT a message does not spend the budget (acceptSave refuses it on its own)", async () => {
    mocks.acceptSave.mockRejectedValueOnce(new Error("requires a submitted support request"));
    const res = await postSaves({ kind: "SUPPORT" });
    expect(mocks.supportBudgetExceeded).not.toHaveBeenCalled();
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=1");
  });

  it("other save kinds never consult the support budget", async () => {
    await postSaves({ kind: "DISCOUNT" });
    expect(mocks.supportBudgetExceeded).not.toHaveBeenCalled();
    expect(mocks.acceptSave).toHaveBeenCalledWith("cs_1", "DISCOUNT", expect.anything());
  });

  it("the portal dispatcher's own support case still guards on the shared rows (source pin: payload action filter + 429)", () => {
    const api = src("app/routes/proxy.api.$action.tsx");
    expect(api).toContain('payload: { path: ["action"], equals: "support" }');
    expect(api).toContain("recentSupport > supportSettings.requestsPerHour");
  });
});

// ── 2. Support settings format refinements ───────────────────────────────────

describe("settings.support — save-time format checks match the resolver", () => {
  const base = {
    email: "",
    replyTo: "",
    whatsapp: "",
    chatUrl: "",
    hoursNote: "",
    replyWithinValue: 30,
    replyWithinUnit: "minutes",
    alwaysOn: true,
    requestsPerHour: 3,
  };
  const parse = (over: Record<string, unknown>) =>
    settingsSchemas.support.safeParse({ ...base, ...over });

  it("rejects what the resolver would silently drop (display-name email, no-TLD email, http chat URL, non-numeric WhatsApp)", () => {
    for (const email of ["Care team <care@shop.com>", "care@store", "care @shop.com", "care@shop.com, x@y.com"]) {
      const result = parse({ email });
      expect(result.success, email).toBe(false);
      if (!result.success) expect(result.error.issues[0].path).toEqual(["email"]);
      expect(normalizeSupportEmail(email)).toBeNull();
    }
    const replyTo = parse({ replyTo: "Desk <desk@helpdesk.io>" });
    expect(replyTo.success).toBe(false);
    if (!replyTo.success) expect(replyTo.error.issues[0].path).toEqual(["replyTo"]);
    for (const whatsapp of ["+41 abc", "12345", "+1234567890123456"]) {
      expect(parse({ whatsapp }).success, whatsapp).toBe(false);
      expect(normalizeWhatsapp(whatsapp)).toBeNull();
    }
    for (const chatUrl of ["http://chat.example", "chat.example", "javascript:alert(1)"]) {
      expect(parse({ chatUrl }).success, chatUrl).toBe(false);
      expect(normalizeChatUrl(chatUrl)).toBeNull();
    }
  });

  it("accepts exactly what the resolver resolves — and blank always means unset", () => {
    for (const email of ["care@shop.com", "care+desk@shop.co.uk", ""]) {
      expect(parse({ email }).success, email).toBe(true);
      if (email) expect(normalizeSupportEmail(email)).toBe(email);
    }
    for (const whatsapp of ["+41791234567", "+41 79 123 45 67", "0041-79-123-45-67", "41791234567", ""]) {
      expect(parse({ whatsapp }).success, whatsapp).toBe(true);
      if (whatsapp) expect(normalizeWhatsapp(whatsapp)).toBe("+41791234567");
    }
    for (const chatUrl of ["https://chat.example/widget", ""]) {
      expect(parse({ chatUrl }).success, chatUrl).toBe(true);
      if (chatUrl) expect(normalizeChatUrl(chatUrl)).toBe(chatUrl);
    }
    // Trimmed before checking (the Settings form posts raw text).
    expect(parse({ email: "  care@shop.com  " }).success).toBe(true);
  });

  it("the Settings page shows Reply-To's Klaviyo creation-only caveat next to the field", () => {
    const page = src("app/routes/app.settings.tsx");
    expect(page).toContain("Klaviyo-delivered flows take the Reply-To only when the app creates them");
  });
});

// ── 3. Klaviyo dedupe off for support.requested ──────────────────────────────

describe("support.requested → Klaviyo with dedupe OFF", () => {
  const baseEvent = {
    id: "ev_1",
    shopId: "shop_1",
    contractId: null,
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    phone: null,
    source: "CUSTOMER_PORTAL",
    actor: "customer",
    createdAt: new Date(),
  };

  it("NO_DEDUPE_EVENT_TYPES is exactly {support.requested}", () => {
    expect([...NO_DEDUPE_EVENT_TYPES]).toEqual(["support.requested"]);
  });

  it("enqueue receives { dedupe: false } for support.requested and {} for every other mapped event", async () => {
    await enqueueKlaviyoForEvent({
      ...baseEvent,
      type: "support.requested",
      payload: { topic: "DELIVERY", message: "late", surface: "portal_detail" },
    } as never);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0][2]).toEqual({ dedupe: false });
    // Properties are the payload verbatim (camelCase) — what the docs list.
    expect((mocks.enqueue.mock.calls[0][1] as { properties: Record<string, unknown> }).properties).toEqual(
      expect.objectContaining({ topic: "DELIVERY", message: "late", surface: "portal_detail" }),
    );

    mocks.enqueue.mockClear();
    await enqueueKlaviyoForEvent({
      ...baseEvent,
      type: "survey.answered",
      payload: {},
    } as never);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0][2]).toEqual({});
  });

  it("the map comment and KLAVIYO_SETUP.md name the REAL (camelCase) properties; the setup doc has the metric row", () => {
    const map = src("app/lib/klaviyo/events-map.server.ts");
    expect(map).not.toContain("Properties: topic, order_ref, push_back");
    expect(map).toMatch(/topic, contractId, orderRef, pushBack,\s*\/\/\s*pushBackApplied/);
    const doc = src("docs/KLAVIYO_SETUP.md");
    expect(doc).toContain("| `Cellexia Support Requested` |");
    for (const key of ["`topic`", "`orderRef`", "`pushBack`", "`pushBackApplied`", "`message`", "`surface`", "`cancelReason`"]) {
      expect(doc, key).toContain(key);
    }
    expect(doc).not.toContain("`push_back`");
    expect(doc).toContain("Sender and Reply-To of auto-created flows are set at creation only");
    const arch = src("docs/ARCHITECTURE.md");
    expect(arch).toContain("AT CREATION ONLY");
  });
});

// ── 4. Welcome-email heal ────────────────────────────────────────────────────

describe("welcome-email heal on UNKNOWN→billable", () => {
  it("settings.notifications.welcomeHealMaxDays: default 7, integer 0..30, additive default for stored values", () => {
    const parsed = settingsSchemas.notifications.parse({
      upcomingOrderDaysBefore: 3,
      channels: { email: true, sms: true },
    });
    expect(parsed.welcomeHealMaxDays).toBe(7);
    expect(
      settingsSchemas.notifications.safeParse({
        upcomingOrderDaysBefore: 3,
        channels: { email: true, sms: true },
        welcomeHealMaxDays: 31,
      }).success,
    ).toBe(false);
    expect(
      settingsSchemas.notifications.safeParse({
        upcomingOrderDaysBefore: 3,
        channels: { email: true, sms: true },
        welcomeHealMaxDays: 0,
      }).success,
    ).toBe(true);
    expect(src("app/routes/app.settings.tsx")).toContain('path: "welcomeHealMaxDays"');
  });

  it("sync.server.ts re-invokes maybeSendSubscriptionStarted from the same UNKNOWN→billable heal block, bounded by the window and gated on originOrderId", () => {
    const sync = src("app/lib/contracts/sync.server.ts");
    const heal = sync.slice(sync.indexOf("Welcome-email heal"));
    expect(heal).toContain("!isBillableOwnership(existingRow.ownership)");
    expect(heal).toContain("isBillableOwnership(persistedOwnership)");
    expect(heal).toContain("contractRow.originOrderId");
    expect(heal).toContain('getSetting(shop.id, "notifications")');
    expect(heal).toContain("welcomeHealMaxDays > 0 && ageMs <= welcomeHealMaxDays * 86_400_000");
    expect(heal).toContain("maybeSendSubscriptionStarted(shop.id, contractRow.id)");
    // Contained.
    expect(heal).toContain('"[contracts] sync: welcome email heal failed"');
  });

  it("the dedupe skips ONLY SUPPRESSED{reason: foreign_contract} — filtered in JS, never a NOT-on-json-path query", () => {
    const started = src("app/lib/notifications/subscription-started.server.ts");
    expect(started).toContain('return reason !== "foreign_contract";');
    expect(started).not.toMatch(/NOT:\s*\{\s*payload/);
  });
});

// ── 5. Cancel-flow save truth + hidden checkbox ──────────────────────────────

describe("source pins", () => {
  it("acceptSave no longer swallows a failed support record (SAVED means a request was submitted)", () => {
    const engine = src("app/lib/cancel/engine.server.ts");
    const block = engine.slice(engine.indexOf('case "EDUCATION":'), engine.indexOf("// The session itself was already closed"));
    expect(block).not.toContain("[cancel] support request from save card failed");
    expect(block).toContain("await submitSupportRequest({");
    expect(block).not.toMatch(/try\s*\{\s*const \{ submitSupportRequest \}/);
  });

  it("the portal stylesheet hides [hidden] .cxs-check rows", () => {
    expect(src("app/lib/portal/layout.server.ts")).toContain(".cxs-check[hidden]{display:none}");
  });
});
