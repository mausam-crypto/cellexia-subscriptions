import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P1.8 — new-method detection on the payment-method webhook (v1.28.0):
 *
 *  - a NEW live method on a customer whose contract has a DEAD primary
 *    (removed / expired) → auto-switch through changePaymentMethod (trigger
 *    new_method, source WEBHOOK, actor system) + event
 *    dunning.new_method_detected {action: "switched"};
 *  - a new method while the primary is still live but the contract is in
 *    trouble (open case / FAILED / expiring) → new_card_detected notice with
 *    USE_METHOD + SET_BACKUP links, event {action: "notified"};
 *  - gates: healthy contract, demo, ended statuses, feature switch off,
 *    SETUP launch mode, the method missing / revoked from the account list,
 *    the method already the primary → nothing;
 *  - dedupe: a prior dunning.new_method_detected for {contract, method}
 *    stops both branches;
 *  - containment: a failed auto-switch degrades to the notice; a failed
 *    notice logs no event (so the banner never promises an untold card);
 *    a thrown detection never reaches the webhook handler;
 *  - closed loop copy: changePaymentMethod with trigger new_method asks the
 *    notice helper for reason "new_method" (payment-method.server) and that
 *    reason renders the "moved your subscription to your new card" line.
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: Record<string, unknown>): Promise<void> => {}),
  eventFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  eventFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  dunningCaseFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  dunningCaseFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  getSetting: vi.fn(async (_shop: string, key: string): Promise<unknown> => {
    if (key === "dunning") {
      return {
        preExpiryNoticeDays: 30,
        cancelAfterFailedDays: 30,
        newMethodDetection: true,
        newMethodAutoSwitch: true,
      };
    }
    return {};
  }),
  isSetupMode: vi.fn(async (): Promise<boolean> => false),
  changePaymentMethod: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
  sendNotification: vi.fn(async (_i: unknown): Promise<unknown> => ({ status: "SENT" })),
  buildUseMethodUrl: vi.fn(async (_p: unknown): Promise<string> => "https://x/magic/use"),
  buildSetBackupUrl: vi.fn(async (_p: unknown): Promise<string> => "https://x/magic/backup"),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriberEvent: { findFirst: mocks.eventFindFirst, findMany: mocks.eventFindMany },
    dunningCase: { findFirst: mocks.dunningCaseFindFirst, findMany: mocks.dunningCaseFindMany },
  },
}));
vi.mock("~/lib/events/log.server", () => ({
  logEvent: mocks.logEvent,
  logEventOrThrow: mocks.logEvent,
}));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));
vi.mock("~/lib/launch/launch.server", () => ({ isSetupMode: mocks.isSetupMode }));
vi.mock("~/lib/contracts/service.server", () => ({
  changePaymentMethod: mocks.changePaymentMethod,
}));
vi.mock("~/lib/notifications/send.server", () => ({
  sendNotification: mocks.sendNotification,
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
}));
vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildUseMethodUrl: mocks.buildUseMethodUrl,
  buildSetBackupUrl: mocks.buildSetBackupUrl,
  buildPortalUrl: vi.fn(async (): Promise<string> => "https://x/account"),
}));
vi.mock("~/lib/i18n/i18n.server", () => ({
  normalizeLocale: (v: string) => v,
  t: (_l: string, k: string, vars?: Record<string, unknown>) =>
    vars ? `${k}|${JSON.stringify(vars)}` : k,
}));

import {
  detectNewPaymentMethod,
  newCardBannerHits,
} from "~/lib/dunning/new-method.server";

const SHOP = { id: "shop_1", domain: "cellexia.myshopify.com", ianaTimezone: "Europe/Zurich" };
const CUSTOMER = "gid://shopify/Customer/1";
const PM_OLD = "gid://shopify/CustomerPaymentMethod/old";
const PM_NEW = "gid://shopify/CustomerPaymentMethod/new";
const NOW = new Date("2026-08-17T10:00:00Z");

function contract(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: SHOP.id,
    shopifyContractId: "gid://shopify/SubscriptionContract/500",
    customerId: CUSTOMER,
    email: "sub@example.com",
    locale: "en",
    status: "ACTIVE",
    ownership: "OURS",
    isDemo: false,
    paymentMethodId: PM_OLD,
    backupPaymentMethodId: null,
    cardBrand: "visa",
    cardLast4: "4242",
    cardExpiryMonth: 4,
    cardExpiryYear: 2028,
    paymentInstrumentType: "CREDIT_CARD",
    paymentMethodRevokedAt: null,
    nextBillingDate: new Date("2026-09-12T09:00:00Z"),
    ...over,
  } as never;
}

function method(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    revoked: false,
    revokedAt: null,
    revokedReason: null,
    instrument: {
      type: "CREDIT_CARD",
      brand: "mastercard",
      lastDigits: "8210",
      expiryMonth: 1,
      expiryYear: 2030,
      expiresSoon: false,
    },
    ...over,
  } as never;
}

function events(type: string) {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
    .filter((e) => e.type === type);
}

function run(over: Partial<Parameters<typeof detectNewPaymentMethod>[0]> = {}) {
  return detectNewPaymentMethod({
    shop: SHOP,
    customerGid: CUSTOMER,
    methodGid: PM_NEW,
    contracts: [contract()],
    methods: [method(PM_OLD, { instrument: { type: "CREDIT_CARD", brand: "visa", lastDigits: "4242", expiryMonth: 4, expiryYear: 2028, expiresSoon: false } }), method(PM_NEW)],
    now: NOW,
    ...over,
  });
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.eventFindFirst.mockResolvedValue(null);
  mocks.dunningCaseFindFirst.mockResolvedValue(null);
  mocks.isSetupMode.mockResolvedValue(false);
  mocks.sendNotification.mockResolvedValue({ status: "SENT" });
  mocks.changePaymentMethod.mockResolvedValue({});
});
afterEach(() => consoleError.mockRestore());

describe("switch branch — dead primary", () => {
  it("revoked primary → changePaymentMethod(new_method, WEBHOOK, system) + event switched", async () => {
    const res = await run({
      contracts: [contract({ paymentMethodRevokedAt: new Date("2026-08-10T00:00:00Z") })],
    });
    expect(res).toEqual([{ contractId: "c_1", action: "switched", reason: "revoked" }]);
    expect(mocks.changePaymentMethod).toHaveBeenCalledWith(SHOP.domain, "c_1", PM_NEW, {
      source: "WEBHOOK",
      actor: "system",
      trigger: "new_method",
    });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    const [ev] = events("dunning.new_method_detected");
    expect(ev.payload).toMatchObject({
      contractId: "c_1",
      paymentMethodId: PM_NEW,
      action: "switched",
      reason: "revoked",
      previousPaymentMethodId: PM_OLD,
      cardLast4: "8210",
    });
  });

  it("expired primary (past its expiry month) → switched", async () => {
    const res = await run({
      contracts: [contract({ cardExpiryMonth: 6, cardExpiryYear: 2026 })],
    });
    expect(res[0]).toMatchObject({ action: "switched", reason: "expired" });
  });

  it("newMethodAutoSwitch off → dead primary is only NOTIFIED", async () => {
    mocks.getSetting.mockResolvedValueOnce({
      preExpiryNoticeDays: 30,
      cancelAfterFailedDays: 30,
      newMethodDetection: true,
      newMethodAutoSwitch: false,
    });
    const res = await run({
      contracts: [contract({ paymentMethodRevokedAt: new Date("2026-08-10T00:00:00Z") })],
    });
    expect(res[0]).toMatchObject({ action: "notified", reason: "revoked" });
    expect(mocks.changePaymentMethod).not.toHaveBeenCalled();
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("auto-switch failure is contained → falls back to the notice", async () => {
    mocks.changePaymentMethod.mockRejectedValueOnce(new Error("shopify down"));
    const res = await run({
      contracts: [contract({ paymentMethodRevokedAt: new Date("2026-08-10T00:00:00Z") })],
    });
    expect(res[0]).toMatchObject({ action: "notified" });
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(events("dunning.new_method_detected")[0].payload).toMatchObject({ action: "notified" });
  });
});

describe("notify branch — live primary, contract in trouble", () => {
  it("open dunning case → new_card_detected with USE_METHOD + SET_BACKUP links, held intro, event notified", async () => {
    mocks.dunningCaseFindFirst.mockResolvedValue({ id: "case_1" });
    const res = await run();
    expect(res).toEqual([{ contractId: "c_1", action: "notified", reason: "open_case" }]);
    expect(mocks.changePaymentMethod).not.toHaveBeenCalled();
    const call = mocks.sendNotification.mock.calls[0][0] as {
      template: string;
      contractId: string;
      vars: Record<string, unknown>;
    };
    expect(call.template).toBe("new_card_detected");
    expect(call.contractId).toBe("c_1");
    expect(call.vars.use_url).toBe("https://x/magic/use");
    expect(call.vars.cta_url).toBe("https://x/magic/use");
    expect(call.vars.backup_url).toBe("https://x/magic/backup");
    expect(String(call.vars.intro_line)).toContain("email.new_card_detected.intro_held");
    expect(String(call.vars.backup_line)).toContain("email.new_card_detected.backup_line");
    expect(String(call.vars.backup_line)).toContain("https://x/magic/backup");
    // Links are minted for THIS contract + the webhook's method only.
    expect(mocks.buildUseMethodUrl).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: "c_1", paymentMethodId: PM_NEW, createdVia: "NEW_CARD_DETECTED", ttlDays: 37 }),
    );
    expect(mocks.buildSetBackupUrl).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: "c_1", paymentMethodId: PM_NEW }),
    );
    const [ev] = events("dunning.new_method_detected");
    expect(ev.payload).toMatchObject({ action: "notified", paymentMethodId: PM_NEW, reason: "open_case" });
  });

  it("FAILED contract without an open case → notified (held intro)", async () => {
    const res = await run({ contracts: [contract({ status: "FAILED" })] });
    expect(res[0]).toMatchObject({ action: "notified", reason: "failed" });
    const call = mocks.sendNotification.mock.calls[0][0] as { vars: Record<string, unknown> };
    expect(String(call.vars.intro_line)).toContain("intro_held");
  });

  it("card expiring inside preExpiryNoticeDays → notified with the expiring intro", async () => {
    const res = await run({ contracts: [contract({ cardExpiryMonth: 8, cardExpiryYear: 2026 })] });
    expect(res[0]).toMatchObject({ action: "notified", reason: "expiring" });
    const call = mocks.sendNotification.mock.calls[0][0] as { vars: Record<string, unknown> };
    expect(String(call.vars.intro_line)).toContain("intro_expiring");
  });

  it("a notice that is not SENT logs no event (nothing for the banner to promise)", async () => {
    mocks.dunningCaseFindFirst.mockResolvedValue({ id: "case_1" });
    mocks.sendNotification.mockResolvedValueOnce({ status: "SUPPRESSED" });
    const res = await run();
    expect(res[0]).toMatchObject({ action: "skipped", reason: "notice_SUPPRESSED" });
    expect(events("dunning.new_method_detected")).toHaveLength(0);
  });

  it("a failed SET_BACKUP mint drops the backup line, never a raw placeholder", async () => {
    mocks.dunningCaseFindFirst.mockResolvedValue({ id: "case_1" });
    mocks.buildSetBackupUrl.mockRejectedValueOnce(new Error("mint failed"));
    await run();
    const call = mocks.sendNotification.mock.calls[0][0] as { vars: Record<string, unknown> };
    expect(call.vars.backup_line).toBe("");
    expect(call.vars.backup_url).toBeUndefined();
    expect(call.vars.use_url).toBe("https://x/magic/use");
  });
});

describe("gates + dedupe", () => {
  it("healthy contract → nothing", async () => {
    const res = await run();
    expect(res).toEqual([{ contractId: "c_1", action: "skipped", reason: "healthy" }]);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("demo / cancelled / expired contracts are never candidates", async () => {
    mocks.dunningCaseFindFirst.mockResolvedValue({ id: "case_1" });
    const res = await run({
      contracts: [
        contract({ id: "demo", isDemo: true }),
        contract({ id: "cancelled", status: "CANCELLED" }),
        contract({ id: "expired", status: "EXPIRED" }),
      ],
    });
    expect(res).toEqual([]);
    expect(mocks.getSetting).not.toHaveBeenCalled();
  });

  it("method already the contract's primary → nothing", async () => {
    mocks.dunningCaseFindFirst.mockResolvedValue({ id: "case_1" });
    const res = await run({ contracts: [contract({ paymentMethodId: PM_NEW })] });
    expect(res).toEqual([]);
  });

  it("method missing from / revoked on the account list → nothing", async () => {
    mocks.dunningCaseFindFirst.mockResolvedValue({ id: "case_1" });
    expect(await run({ methods: [method(PM_OLD)] })).toEqual([]);
    expect(await run({ methods: [method(PM_OLD), method(PM_NEW, { revoked: true })] })).toEqual([]);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("FOREIGN / UNKNOWN (other app's) contracts are never candidates: no switch, no notice, no event (Stage G review fix)", async () => {
    const res = await run({
      contracts: [
        contract({ id: "joy", ownership: "FOREIGN", paymentMethodRevokedAt: new Date("2026-08-10T00:00:00Z") }),
        contract({ id: "unk", ownership: "UNKNOWN", paymentMethodRevokedAt: new Date("2026-08-10T00:00:00Z") }),
      ],
    });
    expect(res).toEqual([]);
    expect(mocks.changePaymentMethod).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
    expect(mocks.getSetting).not.toHaveBeenCalled();
  });

  it("an already-EXPIRED target instrument is never switched onto nor offered (skipped target_expired)", async () => {
    mocks.dunningCaseFindFirst.mockResolvedValue({ id: "case_1" });
    const expiredTarget = method(PM_NEW, {
      instrument: { type: "CREDIT_CARD", brand: "mastercard", lastDigits: "8888", expiryMonth: 12, expiryYear: 2025, expiresSoon: false },
    });
    // switch branch (dead primary) …
    const r1 = await run({
      contracts: [contract({ paymentMethodRevokedAt: new Date("2026-08-10T00:00:00Z") })],
      methods: [method(PM_OLD), expiredTarget],
    });
    expect(r1).toEqual([{ contractId: "c_1", action: "skipped", reason: "target_expired" }]);
    // … and notify branch (open case)
    const r2 = await run({ methods: [method(PM_OLD), expiredTarget] });
    expect(r2).toEqual([{ contractId: "c_1", action: "skipped", reason: "target_expired" }]);
    expect(mocks.changePaymentMethod).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
    // A target without expiry data (PayPal / unknown) is still eligible.
    const r3 = await run({ methods: [method(PM_OLD), method(PM_NEW, { instrument: { type: "PAYPAL", brand: null, lastDigits: null, expiryMonth: null, expiryYear: null, expiresSoon: null } })] });
    expect(r3[0]).toMatchObject({ action: "notified" });
  });

  it("the UPDATE topic is a card-detail edit, not 'a new card': skipped not_new for both branches", async () => {
    mocks.dunningCaseFindFirst.mockResolvedValue({ id: "case_1" });
    const r1 = await run({
      topic: "UPDATE",
      contracts: [contract({ paymentMethodRevokedAt: new Date("2026-08-10T00:00:00Z") })],
    });
    expect(r1).toEqual([{ contractId: "c_1", action: "skipped", reason: "not_new" }]);
    const r2 = await run({ topic: "UPDATE" });
    expect(r2).toEqual([{ contractId: "c_1", action: "skipped", reason: "not_new" }]);
    expect(mocks.changePaymentMethod).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
    // CREATE (explicit) behaves as before.
    const r3 = await run({ topic: "CREATE" });
    expect(r3[0]).toMatchObject({ action: "notified", reason: "open_case" });
  });

  it("feature switch off → nothing", async () => {
    mocks.dunningCaseFindFirst.mockResolvedValue({ id: "case_1" });
    mocks.getSetting.mockResolvedValueOnce({ newMethodDetection: false });
    expect(await run()).toEqual([]);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("SETUP launch mode → nothing", async () => {
    mocks.dunningCaseFindFirst.mockResolvedValue({ id: "case_1" });
    mocks.isSetupMode.mockResolvedValue(true);
    expect(await run()).toEqual([]);
    expect(mocks.changePaymentMethod).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("dedupe: a prior dunning.new_method_detected for {contract, method} stops both branches", async () => {
    mocks.eventFindFirst.mockResolvedValue({ id: "ev_prior" });
    // switch branch
    const r1 = await run({
      contracts: [contract({ paymentMethodRevokedAt: new Date("2026-08-10T00:00:00Z") })],
    });
    expect(r1[0]).toMatchObject({ action: "skipped", reason: "duplicate" });
    // notify branch
    mocks.dunningCaseFindFirst.mockResolvedValue({ id: "case_1" });
    const r2 = await run();
    expect(r2[0]).toMatchObject({ action: "skipped", reason: "duplicate" });
    expect(mocks.changePaymentMethod).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
    // The dedupe read is keyed on the method id.
    expect(mocks.eventFindFirst.mock.calls[0][0]).toMatchObject({
      where: {
        contractId: "c_1",
        type: "dunning.new_method_detected",
        payload: { path: ["paymentMethodId"], equals: PM_NEW },
      },
    });
  });

  it("a per-contract failure is contained and the other contracts still run", async () => {
    mocks.dunningCaseFindFirst
      .mockRejectedValueOnce(new Error("db blip"))
      .mockResolvedValueOnce({ id: "case_2" });
    const res = await run({ contracts: [contract({ id: "c_1" }), contract({ id: "c_2" })] });
    expect(res).toEqual([
      { contractId: "c_1", action: "skipped", reason: "error" },
      { contractId: "c_2", action: "notified", reason: "open_case" },
    ]);
  });
});

describe("home banner lookup (newCardBannerHits)", () => {
  it("returns the newest NOTIFIED method per contract inside the window, dropping contracts already on it", async () => {
    mocks.eventFindMany.mockResolvedValue([
      { contractId: "c_1", payload: { action: "notified", paymentMethodId: PM_NEW, cardBrand: "mastercard", cardLast4: "8210", instrumentType: "CREDIT_CARD" } },
      { contractId: "c_1", payload: { action: "notified", paymentMethodId: "gid://shopify/CustomerPaymentMethod/older" } },
      { contractId: "c_2", payload: { action: "switched", paymentMethodId: PM_NEW } },
      { contractId: "c_3", payload: { action: "notified", paymentMethodId: PM_NEW } },
    ]);
    // Every candidate still in trouble (open case) for this shape test.
    mocks.dunningCaseFindMany.mockResolvedValue([{ contractId: "c_1" }, { contractId: "c_2" }, { contractId: "c_3" }]);
    const hits = await newCardBannerHits(
      [
        contract({ id: "c_1" }),
        contract({ id: "c_2" }),
        contract({ id: "c_3", paymentMethodId: PM_NEW }),
        contract({ id: "demo", isDemo: true }),
        contract({ id: "gone", status: "CANCELLED" }),
      ] as never,
      { now: NOW },
    );
    expect([...hits.keys()]).toEqual(["c_1"]);
    expect(hits.get("c_1")).toEqual({
      contractId: "c_1",
      paymentMethodId: PM_NEW,
      cardBrand: "mastercard",
      cardLast4: "8210",
      instrumentType: "CREDIT_CARD",
    });
    const where = (mocks.eventFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.type).toBe("dunning.new_method_detected");
    expect((where.contractId as { in: string[] }).in).toEqual(["c_1", "c_2", "c_3"]);
    expect((where.createdAt as { gte: Date }).gte.getTime()).toBe(NOW.getTime() - 30 * 86_400_000);
  });

  it("is contained: a failed read yields an empty map", async () => {
    mocks.eventFindMany.mockRejectedValueOnce(new Error("db"));
    expect((await newCardBannerHits([contract()] as never)).size).toBe(0);
  });

  // ── Stage G review fixes ────────────────────────────────────────────────
  const notified = (contractId: string, paymentMethodId = PM_NEW) => ({
    contractId,
    payload: { action: "notified", paymentMethodId, cardBrand: "mastercard", cardLast4: "8210", instrumentType: "CREDIT_CARD" },
  });

  it("hides once the customer chose SET_BACKUP for that card (backupPaymentMethodId === notified method)", async () => {
    mocks.eventFindMany.mockResolvedValue([notified("c_1")]);
    mocks.dunningCaseFindMany.mockResolvedValue([{ contractId: "c_1" }]);
    const hits = await newCardBannerHits([contract({ id: "c_1", backupPaymentMethodId: PM_NEW })] as never, { now: NOW });
    expect(hits.size).toBe(0);
  });

  it("hides once the contract is healthy again (no open case, primary live, not expiring)", async () => {
    mocks.eventFindMany.mockResolvedValue([notified("c_1")]);
    mocks.dunningCaseFindMany.mockResolvedValue([]); // case RESOLVED since
    const healthy = await newCardBannerHits([contract({ id: "c_1" })] as never, { now: NOW, tz: SHOP.ianaTimezone });
    expect(healthy.size).toBe(0);
    // …but stays while still in trouble: FAILED, revoked primary, expiring card, open case.
    for (const over of [
      { status: "FAILED" },
      { paymentMethodRevokedAt: new Date("2026-08-10T00:00:00Z") },
      { cardExpiryMonth: 8, cardExpiryYear: 2026 },
    ]) {
      const hits = await newCardBannerHits([contract({ id: "c_1", ...over })] as never, { now: NOW, tz: SHOP.ianaTimezone });
      expect(hits.has("c_1"), JSON.stringify(over)).toBe(true);
    }
    mocks.dunningCaseFindMany.mockResolvedValue([{ contractId: "c_1" }]);
    expect((await newCardBannerHits([contract({ id: "c_1" })] as never, { now: NOW })).has("c_1")).toBe(true);
    // The open-case lookup is scoped to the candidates and to open states.
    const where = (mocks.dunningCaseFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect((where.contractId as { in: string[] }).in).toEqual(["c_1"]);
    expect(where.state).toBeDefined();
  });

  it("hides when the notified method is no longer live on the account; keeps the hit when liveness is unknown", async () => {
    mocks.eventFindMany.mockResolvedValue([notified("c_1")]);
    mocks.dunningCaseFindMany.mockResolvedValue([{ contractId: "c_1" }]);
    const liveMethodIds = vi.fn(async () => new Set([PM_OLD])); // PM_NEW revoked since
    expect((await newCardBannerHits([contract({ id: "c_1" })] as never, { now: NOW, liveMethodIds })).size).toBe(0);
    expect(liveMethodIds).toHaveBeenCalledWith(CUSTOMER);
    expect((await newCardBannerHits([contract({ id: "c_1" })] as never, { now: NOW, liveMethodIds: async () => new Set([PM_OLD, PM_NEW]) })).has("c_1")).toBe(true);
    expect((await newCardBannerHits([contract({ id: "c_1" })] as never, { now: NOW, liveMethodIds: async () => null })).has("c_1")).toBe(true);
    expect((await newCardBannerHits([contract({ id: "c_1" })] as never, { now: NOW, liveMethodIds: async () => { throw new Error("shopify"); } })).has("c_1")).toBe(true);
  });

  it("the newest row per contract is terminal: a later 'switched' (to another card) buries an older 'notified' about A", async () => {
    mocks.eventFindMany.mockResolvedValue([
      { contractId: "c_1", payload: { action: "switched", paymentMethodId: "gid://shopify/CustomerPaymentMethod/C" } },
      notified("c_1", "gid://shopify/CustomerPaymentMethod/A"),
    ]);
    mocks.dunningCaseFindMany.mockResolvedValue([{ contractId: "c_1" }]);
    const hits = await newCardBannerHits([contract({ id: "c_1", paymentMethodId: "gid://shopify/CustomerPaymentMethod/C" })] as never, { now: NOW });
    expect(hits.size).toBe(0);
  });
});
