import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Concierge save (v1.28.0, P3.7) — the SUPPORT card is an in-flow request
 * that keeps the subscriber while a human answers.
 *
 * Pins:
 *  - the card prefills the Get-help topic from the cancel reason and the
 *    survey free text as the message draft, states the reply promise
 *    (support.replyWithin*, v1.29.0) and the next-order hold ONLY when it applies;
 *  - accepting SUPPORT routes the request with saveRequest + reasonDetail
 *    (alert flag + admin visibility), closes the session as SAVED_PENDING
 *    (distinct from SAVED — a request is not yet a save), and HOLDS the next
 *    order by cancelFlow.conciergeHoldDays through the portal's delay path
 *    only when the charge is > 48h away, the contract is ACTIVE and not
 *    locked; a failed hold never reverts the save (the request is the save);
 *  - conciergeHoldPlan is the single rule (card promise = accept behaviour);
 *  - the SLA job raises ONE CRITICAL SUPPORT_SLA_BREACH per unanswered save
 *    request past the reply promise (legacy slaBusinessDays ⇒ business days), and promotes SAVED_PENDING
 *    → SAVED once the request alert is resolved while the contract lives;
 *  - businessDaysBetween skips weekends in the shop timezone;
 *  - the support request module carries the new fields to the event, alert
 *    context (dedupe per cancel session) and merchant email; the admin
 *    subscriber page renders the save-request badge and the survey text.
 */

const store = vi.hoisted(() => ({
  contract: {} as Record<string, unknown>,
  session: {} as Record<string, unknown>,
  cancelFlow: {} as Record<string, unknown>,
  portal: {} as Record<string, unknown>,
  locked: false,
  claims: [] as Array<Record<string, unknown>>,
  reverts: [] as Array<Record<string, unknown>>,
  alerts: [] as Array<Record<string, unknown>>,
  sessionUpdates: [] as Array<Record<string, unknown>>,
}));

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  submitSupportRequest: vi.fn(async (_input: unknown): Promise<unknown> => ({
    eventLogged: true,
    pushBackApplied: false,
    pushBackFailed: false,
    alertRaised: true,
    emailSent: true,
    replyWithin: { value: 2, unit: "business_days", alwaysOn: false },
  })),
  delaySchedule: vi.fn(async (): Promise<unknown> => ({ ...store.contract, nextBillingDate: new Date("2026-09-08T00:00:00Z") })),
  delayNextCycle: vi.fn(async (): Promise<unknown> => ({ ...store.contract, nextBillingDate: new Date("2026-09-08T00:00:00Z") })),
  raiseAlert: vi.fn(async (): Promise<boolean> => true),
}));

vi.mock("~/db.server", () => ({
  default: {
    shop: {
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => ({
        id: "shop_1",
        domain: "cellexia.myshopify.com",
        ianaTimezone: "Europe/Zurich",
      })),
    },
    sellingPlanConfig: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    subscriptionContract: {
      findUnique: vi.fn(async (): Promise<unknown> => store.contract),
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => store.contract),
      findMany: vi.fn(async (): Promise<unknown[]> => [{ id: "c_1" }]),
      update: vi.fn(async (): Promise<unknown> => ({})),
    },
    discountGrant: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    giftGrant: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    billingAttempt: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    subscriberEvent: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    alert: { findMany: vi.fn(async (): Promise<unknown[]> => store.alerts) },
    cancelSession: {
      findUnique: vi.fn(async (): Promise<unknown> => store.session),
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => store.session),
      updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown> => {
        if (args.where.outcome === null) {
          store.claims.push(args.data);
          return { count: 1 };
        }
        store.sessionUpdates.push({ ...args.where, ...args.data });
        return { count: (store.session as { outcome?: string }).outcome === args.where.outcome ? 1 : 0 };
      }),
      update: vi.fn(async (args: { data: Record<string, unknown> }): Promise<unknown> => {
        store.reverts.push(args.data);
        return store.session;
      }),
    },
  },
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "cancelFlow") return store.cancelFlow;
    if (key === "portal") return store.portal;
    if (key === "support") return { slaBusinessDays: 2 };
    if (key === "pause") return { maxMonths: 3 };
    return {};
  }),
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
}));
vi.mock("~/lib/billing/stacking.server", () => ({
  clampGrantPercentForContract: vi.fn(async (): Promise<unknown> => ({ percent: 15 })),
}));
vi.mock("~/lib/billing/timing.server", () => ({
  isPreparingOrder: vi.fn(async (): Promise<boolean> => false),
  resolveChargeTiming: vi.fn(async (): Promise<unknown> => ({ chargeHourLocal: 0 })),
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/graphql/client.server", () => ({ gql: vi.fn(async () => ({})) }));
vi.mock("~/lib/graphql/billingCycles.server", () => ({
  getBillingCycleByDate: vi.fn(async (): Promise<unknown> => null),
  getBillingCycleByIndex: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/gifts/picker.server", () => ({
  pickGiftForContract: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/experiments/index.server", () => ({
  settingOverride: vi.fn(async (a: { current: unknown }) => a.current),
}));
vi.mock("~/lib/contracts/lock.server", () => ({
  resolveLockState: vi.fn(async () => ({
    locked: store.locked,
    until: store.locked ? new Date("2026-10-01T00:00:00Z") : null,
    lockDays: store.locked ? 60 : 0,
  })),
}));
vi.mock("~/lib/portal/catalog.server", () => ({
  getPortalCatalog: vi.fn(async (): Promise<unknown> => []),
}));
vi.mock("~/lib/analytics/alerts.server", () => ({ raiseAlert: mocks.raiseAlert }));
vi.mock("~/lib/contracts/service.server", () => ({
  applyDiscountGrant: vi.fn(async (): Promise<unknown> => ({})),
  cancelContract: vi.fn(async (): Promise<unknown> => ({})),
  changeFrequency: vi.fn(async (): Promise<unknown> => ({})),
  changeLineQuantity: vi.fn(async (): Promise<unknown> => ({})),
  delayNextCycle: mocks.delayNextCycle,
  delaySchedule: mocks.delaySchedule,
  extendPause: vi.fn(async (): Promise<unknown> => ({})),
  pauseContract: vi.fn(async (): Promise<unknown> => ({})),
  skipLineThisCycle: vi.fn(async (): Promise<unknown> => ({})),
  skipNextCycle: vi.fn(async (): Promise<unknown> => ({})),
  swapLineVariant: vi.fn(async (): Promise<unknown> => ({})),
  swapPriceCentsFor: vi.fn(async (): Promise<number> => 0),
  CycleLineEditError: class extends Error {},
}));
vi.mock("~/lib/support/request.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/support/request.server")>();
  return { ...actual, submitSupportRequest: mocks.submitSupportRequest };
});

import {
  acceptSave,
  conciergeHoldPlan,
  conciergeTopicForReason,
} from "~/lib/cancel/engine.server";
import { SAVED_PENDING } from "~/lib/cancel/config.server";
import { settingsSchemas } from "~/lib/settings/registry.server";
import { pageSaves } from "~/lib/cancel/pages.server";
import { businessDaysBetween, runConciergeSla } from "~/lib/cancel/scheduled.server";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const src = (rel: string) => readFileSync(`${ROOT}${rel}`, "utf8");

const NOW = new Date("2026-08-17T10:00:00Z"); // Monday

function contractFixture(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: "gid://shopify/SubscriptionContract/1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    firstName: "Anna",
    status: "ACTIVE",
    ownership: "OURS",
    currencyCode: "CHF",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    ordersCount: 3,
    nextBillingDate: new Date("2026-09-01T00:00:00Z"),
    lines: [],
    ...over,
  };
}

function sessionFixture(over: Record<string, unknown> = {}) {
  return {
    id: "cs_1",
    contractId: "c_1",
    startedAt: new Date(),
    channel: "PORTAL",
    reason: "SHIPPING_ISSUES",
    reasonDetail: "Two parcels arrived crushed",
    savesShown: [{ kind: "SUPPORT" }],
    saveAccepted: null,
    outcome: null,
    completedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  store.claims = [];
  store.reverts = [];
  store.alerts = [];
  store.sessionUpdates = [];
  store.locked = false;
  store.contract = contractFixture();
  store.session = sessionFixture();
  store.cancelFlow = {
    enabled: true,
    maxSavesShown: 2,
    conciergeHoldDays: 7,
    delaySaveEnabled: true,
    delaySaveMaxDays: 42,
    downsizeSaveEnabled: false,
    giftSaveEnabled: false,
    sessionFreshMinutes: 60,
  };
  store.portal = { delayReanchors: true };
});

describe("conciergeTopicForReason / conciergeHoldPlan", () => {
  it("maps the cancel reason to the Get-help topic", () => {
    expect(conciergeTopicForReason("SHIPPING_ISSUES")).toBe("DELIVERY");
    expect(conciergeTopicForReason("TOO_EXPENSIVE")).toBe("PLAN");
    expect(conciergeTopicForReason("TOO_MUCH_PRODUCT")).toBe("PLAN");
    expect(conciergeTopicForReason("OTHER")).toBe("OTHER");
    expect(conciergeTopicForReason(null)).toBe("OTHER");
  });

  it("applies only when conciergeHoldDays > 0, ACTIVE, > 48h before the charge and not locked", async () => {
    const c = store.contract as unknown as Parameters<typeof conciergeHoldPlan>[1];
    let plan = await conciergeHoldPlan("shop_1", c, "Europe/Zurich", NOW);
    expect(plan).toEqual({ days: 7, applies: true, newNextDate: new Date("2026-09-08T00:00:00Z") });

    // ≤ 48h before the charge: no hold (the order is already in motion).
    plan = await conciergeHoldPlan("shop_1", c, "Europe/Zurich", new Date("2026-08-30T12:00:00Z"));
    expect(plan.applies).toBe(false);

    store.cancelFlow = { ...store.cancelFlow, conciergeHoldDays: 0 };
    plan = await conciergeHoldPlan("shop_1", c, "Europe/Zurich", NOW);
    expect(plan.applies).toBe(false);
    store.cancelFlow = { ...store.cancelFlow, conciergeHoldDays: 7 };

    store.locked = true;
    plan = await conciergeHoldPlan("shop_1", c, "Europe/Zurich", NOW);
    expect(plan.applies).toBe(false);
    store.locked = false;

    const paused = { ...store.contract, status: "PAUSED" } as unknown as typeof c;
    plan = await conciergeHoldPlan("shop_1", paused, "Europe/Zurich", NOW);
    expect(plan.applies).toBe(false);
  });
});

describe("the SUPPORT card (in-flow request form)", () => {
  it("prefills topic + survey text, promises the reply and the hold when it applies", () => {
    const page = pageSaves({
      locale: "en",
      csrf: "tok",
      contractId: "c_1",
      offers: [{ kind: "SUPPORT" }],
      tz: "Europe/Zurich",
      currencyCode: "CHF",
      showError: false,
      concierge: {
        topic: "PLAN",
        prefill: "Two parcels arrived crushed",
        replyWithin: { value: 2, unit: "business_days", alwaysOn: false },
        holdUntil: new Date("2026-09-08T00:00:00Z"),
        holdDays: 7,
      },
    });
    expect(page.body).toContain('name="support_topic" value="PLAN"');
    expect(page.body).toContain(">Two parcels arrived crushed</textarea>");
    expect(page.body).toContain("A human replies within 2 business days.");
    expect(page.body).toContain("hold your next order until September 8, 2026");
    expect(page.body).not.toContain("mailto:");
  });

  it("without a hold plan the hold line is absent; without concierge info the Stage C form stands (DELIVERY)", () => {
    const noHold = pageSaves({
      locale: "en",
      csrf: "tok",
      contractId: "c_1",
      offers: [{ kind: "SUPPORT" }],
      tz: "Europe/Zurich",
      currencyCode: "CHF",
      showError: false,
      concierge: {
        topic: "DELIVERY",
        prefill: "",
        replyWithin: { value: 1, unit: "business_days", alwaysOn: false },
        holdUntil: null,
        holdDays: 7,
      },
    });
    expect(noHold.body).toContain("A human replies within 1 business day.");
    expect(noHold.body).not.toContain("hold your next order");
    const plain = pageSaves({
      locale: "en",
      csrf: "tok",
      contractId: "c_1",
      offers: [{ kind: "SUPPORT" }],
      tz: "Europe/Zurich",
      currencyCode: "CHF",
      showError: false,
    });
    expect(plain.body).toContain('name="support_topic" value="DELIVERY"');
    expect(plain.body).not.toContain("replies within");
  });
});

describe("accepting SUPPORT (concierge)", () => {
  it("routes the request with saveRequest + reasonDetail + reason topic, holds the next order, closes SAVED_PENDING", async () => {
    const result = await acceptSave("cs_1", "SUPPORT", {
      support: { topic: "DELIVERY", message: "Two parcels arrived crushed" },
    });
    expect(mocks.submitSupportRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "DELIVERY",
        surface: "cancel_flow",
        cancelReason: "SHIPPING_ISSUES",
        cancelReasonDetail: "Two parcels arrived crushed",
        cancelSessionId: "cs_1",
        saveRequest: true,
        pushBack: false,
      }),
    );
    // The hold is ALWAYS a one-cycle delay (mode "once"), 7 days — even
    // though portal.delayReanchors is ON here: "we'll hold your next order"
    // is a temporary hold, never a permanent shift of every later order.
    expect(mocks.delayNextCycle).toHaveBeenCalledWith(
      "cellexia.myshopify.com",
      "c_1",
      { days: 7 },
      expect.objectContaining({ source: "CUSTOMER_PORTAL" }),
    );
    expect(mocks.delaySchedule).not.toHaveBeenCalled();
    expect(store.claims[0]).toEqual(
      expect.objectContaining({ outcome: SAVED_PENDING, saveAccepted: "SUPPORT" }),
    );
    expect(store.reverts).toHaveLength(0);
    expect(result.concierge).toEqual({
      holdApplied: true,
      holdDays: 7,
      replyWithin: { value: 2, unit: "business_days", alwaysOn: false },
    });
    expect(result.nextBillingDate).toBe("2026-09-08T00:00:00.000Z");
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "cancel.save_accepted",
        payload: expect.objectContaining({
          saveKind: "SUPPORT",
          pending: true,
          holdApplied: true,
          holdDays: 7,
          replyWithin: { value: 2, unit: "business_days", alwaysOn: false },
        }),
      }),
    );
  });

  it("falls back to the reason-matched topic when the form carries none", async () => {
    store.session = sessionFixture({ reason: "TOO_EXPENSIVE" });
    await acceptSave("cs_1", "SUPPORT", { support: { topic: undefined as never, message: "hi" } });
    expect(mocks.submitSupportRequest).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "PLAN" }),
    );
  });

  it("does not hold within 48h of the charge, when the setting is 0, or when locked — the save still lands", async () => {
    store.contract = contractFixture({ nextBillingDate: new Date(Date.now() + 24 * 3600_000) });
    let result = await acceptSave("cs_1", "SUPPORT", { support: { topic: "DELIVERY", message: "hi" } });
    expect(mocks.delayNextCycle).not.toHaveBeenCalled();
    expect(result.concierge?.holdApplied).toBe(false);
    expect(store.claims[0]).toEqual(expect.objectContaining({ outcome: SAVED_PENDING }));

    store.contract = contractFixture();
    store.session = sessionFixture();
    store.claims = [];
    store.cancelFlow = { ...store.cancelFlow, conciergeHoldDays: 0 };
    result = await acceptSave("cs_1", "SUPPORT", { support: { topic: "DELIVERY", message: "hi" } });
    expect(mocks.delayNextCycle).not.toHaveBeenCalled();
    expect(result.concierge?.holdApplied).toBe(false);
    expect(result.concierge?.holdDays).toBe(0);
  });

  it("the minimum lead is the cancelFlow.conciergeHoldMinLeadHours setting, not a constant", async () => {
    // 36h before the charge: refused under the 48h default…
    store.contract = contractFixture({ nextBillingDate: new Date(Date.now() + 36 * 3600_000) });
    let result = await acceptSave("cs_1", "SUPPORT", { support: { topic: "DELIVERY", message: "hi" } });
    expect(result.concierge?.holdApplied).toBe(false);
    // …applied once the merchant lowers the lead to 24h.
    store.session = sessionFixture();
    store.claims = [];
    store.cancelFlow = { ...store.cancelFlow, conciergeHoldMinLeadHours: 24 };
    result = await acceptSave("cs_1", "SUPPORT", { support: { topic: "DELIVERY", message: "hi" } });
    expect(result.concierge?.holdApplied).toBe(true);
    expect(mocks.delayNextCycle).toHaveBeenCalledTimes(1);
    expect(settingsSchemas.cancelFlow.parse(undefined).conciergeHoldMinLeadHours).toBe(48);
  });

  it("a failed hold never reverts the save (the request IS the save); the page is told", async () => {
    mocks.delayNextCycle.mockRejectedValueOnce(new Error("Shopify down"));
    const result = await acceptSave("cs_1", "SUPPORT", { support: { topic: "DELIVERY", message: "hi" } });
    expect(store.reverts).toHaveLength(0);
    expect(result.concierge?.holdApplied).toBe(false);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "cancel.save_accepted",
        payload: expect.objectContaining({ pending: true, holdApplied: false }),
      }),
    );
  });

  it("EDUCATION keeps closing as SAVED (no hold, no save flag)", async () => {
    store.session = sessionFixture({ savesShown: [{ kind: "EDUCATION" }] });
    await acceptSave("cs_1", "EDUCATION", { support: { topic: "OTHER", message: "hi" } });
    expect(store.claims[0]).toEqual(expect.objectContaining({ outcome: "SAVED", saveAccepted: "EDUCATION" }));
    expect(mocks.submitSupportRequest).toHaveBeenCalledWith(
      expect.objectContaining({ saveRequest: false }),
    );
    expect(mocks.delayNextCycle).not.toHaveBeenCalled();
  });

  it("re-accepting a SAVED_PENDING session replays without a second request", async () => {
    store.session = sessionFixture({ outcome: SAVED_PENDING, saveAccepted: "SUPPORT" });
    await acceptSave("cs_1", "SUPPORT", { support: { topic: "DELIVERY", message: "hi" } });
    expect(mocks.submitSupportRequest).not.toHaveBeenCalled();
    expect(store.claims).toHaveLength(0);
  });
});

describe("businessDaysBetween", () => {
  it("counts Mon–Fri only, in the shop timezone", () => {
    const fri = new Date("2026-08-14T15:00:00Z"); // Friday
    expect(businessDaysBetween(fri, new Date("2026-08-15T10:00:00Z"), "Europe/Zurich")).toBe(0); // Sat
    expect(businessDaysBetween(fri, new Date("2026-08-17T08:00:00Z"), "Europe/Zurich")).toBe(1); // Mon
    expect(businessDaysBetween(fri, new Date("2026-08-19T08:00:00Z"), "Europe/Zurich")).toBe(3); // Wed
    expect(businessDaysBetween(fri, fri, "Europe/Zurich")).toBe(0);
    expect(businessDaysBetween(new Date("2026-08-17T08:00:00Z"), new Date("2026-08-17T20:00:00Z"), "Europe/Zurich")).toBe(0);
    expect(businessDaysBetween(new Date("2026-08-17T08:00:00Z"), new Date("2026-08-18T08:00:00Z"), "Europe/Zurich")).toBe(1);
  });
});

describe("concierge SLA job", () => {
  const requestAlert = (over: Record<string, unknown> = {}) => ({
    id: "al_1",
    shopId: "shop_1",
    type: "SUPPORT_REQUEST",
    createdAt: new Date("2026-08-12T09:00:00Z"), // Wednesday
    resolvedAt: null,
    context: {
      contractId: "c_1",
      cancelSessionId: "cs_1",
      cancelReason: "SHIPPING_ISSUES",
      saveRequest: true,
    },
    ...over,
  });

  it("raises ONE CRITICAL SUPPORT_SLA_BREACH once the promise (2 business days) is exceeded", async () => {
    store.alerts = [requestAlert()];
    // Wed 12 → Mon 17: 3 business days > 2 ⇒ breach.
    const stats = await runConciergeSla(NOW);
    expect(stats.breaches).toBe(1);
    expect(mocks.raiseAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SUPPORT_SLA_BREACH",
        severity: "CRITICAL",
        context: expect.objectContaining({
          contractId: "c_1",
          requestAlertId: "al_1",
          cancelSessionId: "cs_1",
          replyWithin: { value: 2, unit: "business_days", alwaysOn: false },
          elapsedBusinessDays: 3,
        }),
        dedupe: expect.objectContaining({ key: "requestAlertId", value: "al_1" }),
      }),
    );
    // Not yet: Wed 12 → Fri 14 = 2 business days, within the promise.
    mocks.raiseAlert.mockClear();
    const early = await runConciergeSla(new Date("2026-08-14T09:00:00Z"));
    expect(early.breaches).toBe(0);
    expect(mocks.raiseAlert).not.toHaveBeenCalled();
  });

  it("promotes SAVED_PENDING → SAVED once the request alert is resolved while the contract lives", async () => {
    store.alerts = [requestAlert({ resolvedAt: new Date("2026-08-13T09:00:00Z") })];
    store.session = sessionFixture({ outcome: SAVED_PENDING, saveAccepted: "SUPPORT" });
    const stats = await runConciergeSla(NOW);
    expect(stats.promoted).toBe(1);
    expect(store.sessionUpdates).toContainEqual(
      expect.objectContaining({ id: "cs_1", outcome: "SAVED" }),
    );
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "cancel.save_confirmed", payload: expect.objectContaining({ sessionId: "cs_1" }) }),
    );
    expect(mocks.raiseAlert).not.toHaveBeenCalled();
  });

  it("never promotes a cancelled contract's session, and ignores plain (non-save) requests", async () => {
    store.alerts = [requestAlert({ resolvedAt: new Date("2026-08-13T09:00:00Z") })];
    store.contract = contractFixture({ status: "CANCELLED" });
    store.session = sessionFixture({ outcome: SAVED_PENDING, saveAccepted: "SUPPORT" });
    const stats = await runConciergeSla(NOW);
    expect(stats.promoted).toBe(0);
    expect(store.sessionUpdates).toHaveLength(0);
  });
});

describe("support request module + admin surfaces (source pins)", () => {
  const request = src("app/lib/support/request.server.ts");
  it("carries cancelReasonDetail + saveRequest into the event, the alert context (deduped per cancel session) and the merchant email", () => {
    expect(request).toContain("cancelReasonDetail?: string | null");
    expect(request).toContain("saveRequest?: boolean");
    expect(request).toMatch(/type: "support\.requested"[\s\S]*saveRequest: true/);
    expect(request).toMatch(/type: "SUPPORT_REQUEST"[\s\S]*saveRequest: true/);
    expect(request).toContain('{ key: "cancelSessionId", value: input.cancelSessionId, since: dayStart }');
    expect(request).toContain('"Save request"');
    expect(request).toContain('"They wrote on the survey"');
  });

  it("the admin subscriber page shows the save-request badge, the survey text and the scheduled-cancel badge", () => {
    const admin = src("app/routes/app.subscribers.$id.tsx");
    expect(admin).toContain("Save request");
    expect(admin).toContain("On the cancel survey they wrote");
    expect(admin).toContain("cancelScheduledAt: contract.cancelScheduledAt?.toISOString() ?? null");
    expect(admin).toContain("c.cancelScheduledAt ?");
  });

  it("the cancel-flow admin page exposes the concierge/delay/scheduled settings and counts pending + scheduled sessions apart from saved", () => {
    const page = src("app/routes/app.cancel-flow.tsx");
    for (const key of [
      "conciergeHoldDays",
      "delaySaveEnabled",
      "delaySaveMaxDays",
      "scheduledCancelEnabled",
      "scheduledCancelNoticeDays",
    ]) {
      expect(page).toContain(`intField("${key}")`.replace('intField("delaySaveEnabled")', 'formData.get("delaySaveEnabled")').replace('intField("scheduledCancelEnabled")', 'formData.get("scheduledCancelEnabled")'));
    }
    expect(page).toContain('session.outcome === "SAVED_PENDING"');
    expect(page).toContain('session.outcome === "CANCEL_SCHEDULED"');
    expect(page).toContain('label="Pending (concierge)"');
  });

  it("the concierge_sla_run job ticks every 10 minutes (30-minute promise) and cancel_scheduled_run hourly", () => {
    const runner = src("app/lib/jobs/runner.server.ts");
    expect(runner).toMatch(/name: "concierge_sla_run",\s*everyMinutes: 10/);
    expect(runner).toMatch(/name: "cancel_scheduled_run",\s*gatedInSetup: true,\s*everyMinutes: 60/);
  });
});
