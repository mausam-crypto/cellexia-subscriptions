import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Portal dispatcher — Stage D flexibility verbs (v1.28.0, P2.6 / P2.7 /
 * P2.8): pause_until / pause_extend / send_tomorrow / delivery_instructions
 * through the REAL api action with the contracts service mocked.
 *
 *  - pause_until: ACTIVE only, lock-blocked like pause (a REDUCTION), date
 *    shape validated, reason forwarded verbatim (the service normalises),
 *    typed PauseUntilError codes map to their own toasts (never the generic
 *    error), success carries the resume day (d1) and NO undo token;
 *    already PAUSED ⇒ friendly "paused" (idempotent double-tap);
 *  - pause_extend: PAUSED only, the tapped week count must be one of the
 *    merchant's choices still inside the pause maximum (measured from
 *    pausedAt), lock-blocked, success carries the new day (d1);
 *  - send_tomorrow: ACTIVE only, NEVER lock-blocked (acceleration), typed
 *    SendTomorrowError codes → preparing / send_tomorrow_payment /
 *    send_tomorrow_soon, success carries d1/d2 + a next_date Undo token,
 *    a stale expected_next dedupes to the success toast without a call;
 *  - delivery_instructions: ACTIVE || PAUSED (never on CANCELLED), never
 *    lock-blocked, saved vs cleared toasts from the service's mirror.
 */

process.env.APP_SIGNING_SECRET = "test-secret-for-flex-dispatcher";

const SHOP_DOMAIN = "cellexia.myshopify.com";
const DAY_MS = 24 * 3600_000;
const TZ = "Europe/Zurich";

const mocks = vi.hoisted(() => {
  const shop = {
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    primaryDomain: "cellexialabs.com",
    ianaTimezone: "Europe/Zurich",
  };
  class PauseUntilError extends Error {
    constructor(
      readonly code: string,
      readonly maxResumeAt?: Date,
    ) {
      super(`pauseUntil refused: ${code}`);
      this.name = "PauseUntilError";
    }
  }
  class SendTomorrowError extends Error {
    constructor(readonly code: string) {
      super(`sendNextOrderTomorrow refused: ${code}`);
      this.name = "SendTomorrowError";
    }
  }
  return {
    shop,
    PauseUntilError,
    SendTomorrowError,
    portalSettings: {} as Record<string, unknown>,
    pauseSettings: { maxMonths: 3 } as Record<string, unknown>,
    shopFindUnique: vi.fn(async (): Promise<unknown> => ({ id: shop.id })),
    portalSessionFindUnique: vi.fn(async (): Promise<unknown> => null),
    contractFindFirst: vi.fn(async (): Promise<unknown> => null),
    contractFindUnique: vi.fn(async (): Promise<unknown> => null),
    sellingPlanConfigFindMany: vi.fn(async (): Promise<unknown[]> => []),
    subscriberEventFindFirst: vi.fn(async (): Promise<unknown> => null),
    subscriberEventCount: vi.fn(async (): Promise<number> => 1),
    attemptFindMany: vi.fn(async (): Promise<unknown[]> => []),
    logEvent: vi.fn(async (): Promise<void> => {}),
    pauseUntil: vi.fn(
      async (_s: string, _c: string, _resumeAt: Date, _o?: unknown): Promise<unknown> => ({}),
    ),
    extendPause: vi.fn(
      async (_s: string, _c: string, _resumeAt: Date, _o?: unknown): Promise<unknown> => ({}),
    ),
    sendNextOrderTomorrow: vi.fn(async (): Promise<unknown> => ({})),
    setDeliveryInstructions: vi.fn(
      async (_s: string, _c: string, _text: string | null, _o?: unknown): Promise<unknown> => ({}),
    ),
    createSignedPayload: vi.fn(() => "UNDOTOKEN"),
  };
});

vi.mock("~/db.server", () => ({
  default: {
    shop: { findUnique: mocks.shopFindUnique },
    portalSession: { findUnique: mocks.portalSessionFindUnique },
    subscriptionContract: {
      findFirst: mocks.contractFindFirst,
      findUnique: mocks.contractFindUnique,
      findMany: vi.fn(async () => []),
    },
    sellingPlanConfig: { findMany: mocks.sellingPlanConfigFindMany },
    subscriberEvent: {
      findFirst: mocks.subscriberEventFindFirst,
      count: mocks.subscriberEventCount,
    },
    billingAttempt: { findMany: mocks.attemptFindMany },
  },
}));

vi.mock("~/shopify.server", () => ({
  authenticate: {
    public: {
      appProxy: vi.fn(async () => ({
        session: { shop: SHOP_DOMAIN },
        liquid: (body: string, init?: ResponseInit | number) =>
          new Response(body, typeof init === "number" ? { status: init } : init),
      })),
    },
  },
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/lib/shop/install.server", () => ({
  requireShop: vi.fn(async (): Promise<unknown> => mocks.shop),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => mocks.shop),
}));

vi.mock("~/lib/launch/launch.server", () => ({
  isSetupMode: vi.fn(async (): Promise<boolean> => false),
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "portal") {
      return {
        contextualPrompts: false,
        allowAddProducts: true,
        otpCodeTtlMinutes: 10,
        sessionTtlDays: 30,
        mutationsPerHour: 30,
        nextDateMaxDays: 90,
        maxLineQuantity: 20,
        friendlyLockMessaging: false,
        delayReanchors: false,
        magicLinkTtlDays: 14,
        pauseExtendChoicesWeeks: [2, 4],
        deliveryInstructionsMaxChars: 250,
        ...mocks.portalSettings,
      };
    }
    if (key === "pause") return mocks.pauseSettings;
    if (key === "billing") return { chargeHourLocal: 0, preparingWindowHours: 72 };
    return {};
  }),
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

vi.mock("~/lib/crypto/tokens.server", () => ({
  sha256: (data: string) => createHash("sha256").update(data).digest("hex"),
  createMagicToken: vi.fn(async (): Promise<string> => "TOK"),
  verifyAndConsumeMagicToken: vi.fn(),
  createSignedPayload: mocks.createSignedPayload,
  verifySignedPayload: vi.fn(() => null),
}));

vi.mock("~/lib/contracts/service.server", () => ({
  PauseUntilError: mocks.PauseUntilError,
  SendTomorrowError: mocks.SendTomorrowError,
  CycleLineEditError: class extends Error {},
  addLine: vi.fn(),
  addOneTimeAddon: vi.fn(),
  changeFrequency: vi.fn(),
  changeLineQuantity: vi.fn(),
  delayNextCycle: vi.fn(),
  delaySchedule: vi.fn(),
  extendPause: mocks.extendPause,
  pauseContract: vi.fn(),
  pauseUntil: mocks.pauseUntil,
  removeLine: vi.fn(),
  resumeContract: vi.fn(),
  sendNextOrderTomorrow: mocks.sendNextOrderTomorrow,
  setDeliveryInstructions: mocks.setDeliveryInstructions,
  setLineQuantityThisCycle: vi.fn(),
  setNextBillingDate: vi.fn(),
  skipLineThisCycle: vi.fn(),
  skipNextCycle: vi.fn(),
  swapLineVariant: vi.fn(),
  unskipLineThisCycle: vi.fn(),
  unskipNextCycle: vi.fn(),
  updateDeliveryAddress: vi.fn(),
}));

vi.mock("~/lib/winback/engine.server", () => ({
  reactivateFromWinback: vi.fn(),
}));

vi.mock("~/lib/graphql/index.server", () => ({
  getPaymentMethodUpdateUrl: vi.fn(async (): Promise<string> => "https://x"),
}));

vi.mock("~/lib/portal/catalog.server", () => ({
  catalogProduct: vi.fn(() => null),
  discountedCents: vi.fn((cents: number) => cents),
  frequencyOptionsForContract: vi.fn(async () => ({
    options: [{ unit: "WEEK", count: 4 }],
    allowChoice: true,
  })),
  getPortalCatalog: vi.fn(async (): Promise<unknown[]> => []),
  ongoingDiscountPctByProduct: vi.fn(async () => new Map()),
}));

import { action as apiAction } from "~/routes/proxy.api.$action";
import { getPortalSession } from "~/lib/portal/session.server";
import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";
import { addDaysTz, shopDayStartUtc } from "~/lib/dates.server";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date();
const TODAY = shopDayStartUtc(NOW, TZ);
const NEXT_WEEK = new Date(NOW.getTime() + 7 * DAY_MS);

function isoDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function makeLine(over: Record<string, unknown> = {}) {
  return {
    id: "line_1",
    quantity: 2,
    isGift: false,
    isOneTimeAddon: false,
    sellingPlanId: "gid://shopify/SellingPlan/1",
    productId: "gid://shopify/Product/9",
    variantId: "gid://shopify/ProductVariant/111",
    title: "Serum",
    variantTitle: "Default Title",
    currentPriceCents: 5000,
    compareAtPriceCents: null,
    imageUrl: null,
    skippedCycleIndex: null,
    cycleQuantityOverride: null,
    cycleQuantityOverrideIndex: null,
    ...over,
  };
}

function makeContract(over: Record<string, unknown> = {}) {
  return {
    id: "ctr_1",
    lockDays: null,
    shopId: "shop_1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    status: "ACTIVE",
    ownership: "OURS",
    isDemo: false,
    currencyCode: "CHF",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    nextBillingDate: NEXT_WEEK,
    deliveryPriceCents: 0,
    createdAt: new Date(NOW.getTime() - 100 * DAY_MS),
    firstChargeAt: new Date(NOW.getTime() - 100 * DAY_MS),
    ordersCount: 3,
    pausedAt: null,
    resumeAt: null,
    pausedReason: null,
    deliveryInstructions: null,
    lines: [makeLine()],
    ...over,
  };
}

/** Locked: subscribed 2 days ago under a 30-day lock plan. */
function lockedContract(over: Record<string, unknown> = {}) {
  return makeContract({
    lockDays: 30,
    createdAt: new Date(NOW.getTime() - 2 * DAY_MS),
    firstChargeAt: new Date(NOW.getTime() - 2 * DAY_MS),
    ...over,
  });
}

/** PAUSED 10 days ago, resuming in 20 days. */
function pausedContract(over: Record<string, unknown> = {}) {
  return makeContract({
    status: "PAUSED",
    pausedAt: new Date(NOW.getTime() - 10 * DAY_MS),
    resumeAt: shopDayStartUtc(addDaysTz(NOW, 20, TZ), TZ),
    nextBillingDate: null,
    ...over,
  });
}

function proxyUrl(pathname: string, params: Record<string, string> = {}): string {
  const url = new URL(`https://cellexialabs.com${PORTAL_PROXY_BASE}${pathname}`);
  url.searchParams.set("shop", SHOP_DOMAIN);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}

async function licidCsrf(): Promise<string> {
  const session = await getPortalSession(
    new Request(proxyUrl("/", { logged_in_customer_id: "1" })),
  );
  return session?.csrfToken ?? "";
}

async function postAction(action: string, fields: Record<string, string> = {}): Promise<Response> {
  const form = new URLSearchParams({
    contractId: "ctr_1",
    _csrf: await licidCsrf(),
    return_to: "/subscription/ctr_1",
    ...fields,
  });
  return (await apiAction({
    request: new Request(proxyUrl(`/api/${action}`, { logged_in_customer_id: "1" }), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    params: { action },
    context: {},
  } as never)) as Response;
}

function location(response: Response): URL {
  expect(response.status).toBe(302);
  return new URL(response.headers.get("Location") ?? "", "https://cellexialabs.com");
}

function expectToast(response: Response, toast: string): URL {
  const url = location(response);
  expect(url.searchParams.get("toast")).toBe(toast);
  return url;
}

function setContract(contract: unknown) {
  mocks.contractFindFirst.mockResolvedValue(contract);
  mocks.contractFindUnique.mockResolvedValue(contract);
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PORTAL_COOKIE_DEV;
  mocks.portalSettings = {};
  mocks.pauseSettings = { maxMonths: 3 };
  mocks.shopFindUnique.mockResolvedValue({ id: mocks.shop.id });
  mocks.portalSessionFindUnique.mockResolvedValue(null);
  mocks.subscriberEventCount.mockResolvedValue(1);
  mocks.sellingPlanConfigFindMany.mockResolvedValue([
    { lockDays: 30, shopifyPlanIds: ["gid://shopify/SellingPlan/1"] },
  ]);
  mocks.attemptFindMany.mockResolvedValue([]);
  setContract(makeContract());
  mocks.pauseUntil.mockImplementation(async (_s: string, _c: string, resumeAt: Date) =>
    makeContract({ status: "PAUSED", pausedAt: NOW, resumeAt }),
  );
  mocks.extendPause.mockImplementation(async (_s: string, _c: string, resumeAt: Date) =>
    pausedContract({ resumeAt }),
  );
  mocks.sendNextOrderTomorrow.mockImplementation(async () =>
    makeContract({ nextBillingDate: addDaysTz(TODAY, 1, TZ) }),
  );
  mocks.setDeliveryInstructions.mockImplementation(
    async (_s: string, _c: string, text: string | null) =>
      makeContract({ deliveryInstructions: text && text.trim() ? text.trim() : null }),
  );
});

// ── pause_until ──────────────────────────────────────────────────────────────

describe("pause_until", () => {
  it("pauses to the chosen shop-tz day with the reason forwarded and confirms with the resume day", async () => {
    const day = addDaysTz(TODAY, 21, TZ);
    const url = expectToast(
      await postAction("pause_until", { date: isoDay(day), reason: "TRAVEL" }),
      "paused_until",
    );
    expect(mocks.pauseUntil).toHaveBeenCalledTimes(1);
    const [shop, id, resumeAt, opts] = mocks.pauseUntil.mock.calls[0] as unknown as [
      string,
      string,
      Date,
      { reason: string | null; source: string; actor: string },
    ];
    expect(shop).toBe(SHOP_DOMAIN);
    expect(id).toBe("ctr_1");
    expect(shopDayStartUtc(resumeAt, TZ).getTime()).toBe(day.getTime());
    expect(opts).toMatchObject({ reason: "TRAVEL", source: "CUSTOMER_PORTAL", actor: "customer" });
    expect(url.searchParams.get("d1")).toBe(isoDay(day));
    // A hold is reversed with the banner's own controls — never a signed token.
    expect(url.searchParams.get("undo")).toBeNull();
  });

  it("forwards a missing reason as null and refuses a malformed date without calling the service", async () => {
    expectToast(await postAction("pause_until", { date: isoDay(addDaysTz(TODAY, 5, TZ)) }), "paused_until");
    expect((mocks.pauseUntil.mock.calls[0] as unknown[])[3]).toMatchObject({ reason: null });
    mocks.pauseUntil.mockClear();
    expectToast(await postAction("pause_until", { date: "next tuesday" }), "error");
    expectToast(await postAction("pause_until", {}), "error");
    expect(mocks.pauseUntil).not.toHaveBeenCalled();
  });

  it("maps the typed refusals to their own toasts (too far carries the latest allowed day)", async () => {
    const max = shopDayStartUtc(addDaysTz(NOW, 90, TZ), TZ);
    mocks.pauseUntil.mockRejectedValueOnce(new mocks.PauseUntilError("RESUME_DATE_TOO_FAR", max));
    const url = expectToast(
      await postAction("pause_until", { date: isoDay(addDaysTz(TODAY, 200, TZ)) }),
      "pause_too_far",
    );
    expect(url.searchParams.get("d1")).toBe(isoDay(max));

    mocks.pauseUntil.mockRejectedValueOnce(new mocks.PauseUntilError("RESUME_DATE_PAST"));
    expectToast(await postAction("pause_until", { date: isoDay(TODAY) }), "pause_date_past");

    mocks.pauseUntil.mockRejectedValueOnce(new mocks.PauseUntilError("NOT_LATER"));
    expectToast(await postAction("pause_until", { date: isoDay(addDaysTz(TODAY, 5, TZ)) }), "error");
  });

  it("is a REDUCTION (lock-blocked like pause), ACTIVE-only, and idempotent on an already-paused contract", async () => {
    setContract(lockedContract());
    expectToast(await postAction("pause_until", { date: isoDay(addDaysTz(TODAY, 5, TZ)) }), "locked");
    expect(mocks.pauseUntil).not.toHaveBeenCalled();

    setContract(pausedContract());
    expectToast(await postAction("pause_until", { date: isoDay(addDaysTz(TODAY, 5, TZ)) }), "paused");
    expect(mocks.pauseUntil).not.toHaveBeenCalled();

    setContract(makeContract({ status: "CANCELLED" }));
    expectToast(await postAction("pause_until", { date: isoDay(addDaysTz(TODAY, 5, TZ)) }), "error");
    expect(mocks.pauseUntil).not.toHaveBeenCalled();
  });
});

// ── pause_extend ─────────────────────────────────────────────────────────────

describe("pause_extend", () => {
  it("extends by one of the merchant's week choices from the CURRENT resume day and confirms with the new day", async () => {
    const paused = pausedContract();
    setContract(paused);
    const url = expectToast(await postAction("pause_extend", { weeks: "2" }), "pause_extended");
    expect(mocks.extendPause).toHaveBeenCalledTimes(1);
    const [, , newResumeAt] = mocks.extendPause.mock.calls[0] as unknown as [string, string, Date];
    const expected = shopDayStartUtc(addDaysTz(paused.resumeAt as unknown as Date, 14, TZ), TZ);
    expect(newResumeAt.getTime()).toBe(expected.getTime());
    expect(url.searchParams.get("d1")).toBe(isoDay(expected));
  });

  it("refuses a week count outside the merchant's list or beyond the pause maximum (measured from the pause start)", async () => {
    setContract(pausedContract());
    // 3 is not one of [2, 4].
    expectToast(await postAction("pause_extend", { weeks: "3" }), "pause_too_far");
    // Paused 80 days ago with a 90-day maximum: +4 weeks from a resume day
    // 20 days out lands past the clamp — offered nowhere, refused here.
    setContract(
      pausedContract({
        pausedAt: new Date(NOW.getTime() - 80 * DAY_MS),
        resumeAt: shopDayStartUtc(addDaysTz(NOW, 5, TZ), TZ),
      }),
    );
    expectToast(await postAction("pause_extend", { weeks: "4" }), "pause_too_far");
    expect(mocks.extendPause).not.toHaveBeenCalled();
    // Malformed / missing.
    setContract(pausedContract());
    expectToast(await postAction("pause_extend", { weeks: "lots" }), "error");
    expectToast(await postAction("pause_extend", {}), "error");
    expect(mocks.extendPause).not.toHaveBeenCalled();
  });

  it("is PAUSED-only (needs a resume day) and maps the service's typed refusals", async () => {
    setContract(makeContract());
    expectToast(await postAction("pause_extend", { weeks: "2" }), "error");
    setContract(pausedContract({ resumeAt: null }));
    expectToast(await postAction("pause_extend", { weeks: "2" }), "error");
    expect(mocks.extendPause).not.toHaveBeenCalled();

    setContract(pausedContract());
    const max = shopDayStartUtc(addDaysTz(NOW, 30, TZ), TZ);
    mocks.extendPause.mockRejectedValueOnce(new mocks.PauseUntilError("RESUME_DATE_TOO_FAR", max));
    const url = expectToast(await postAction("pause_extend", { weeks: "2" }), "pause_too_far");
    expect(url.searchParams.get("d1")).toBe(isoDay(max));
    mocks.extendPause.mockRejectedValueOnce(new mocks.PauseUntilError("NOT_PAUSED"));
    expectToast(await postAction("pause_extend", { weeks: "2" }), "error");
  });

  it("is lock-blocked (a pause control) with no service call", async () => {
    setContract(lockedContract({ status: "PAUSED", pausedAt: NOW, resumeAt: shopDayStartUtc(addDaysTz(NOW, 20, TZ), TZ) }));
    expectToast(await postAction("pause_extend", { weeks: "2" }), "locked");
    expect(mocks.extendPause).not.toHaveBeenCalled();
  });
});

// ── send_tomorrow ────────────────────────────────────────────────────────────

describe("send_tomorrow", () => {
  it("pulls the next order and confirms with the new day, the following day and a next_date Undo token", async () => {
    const url = expectToast(await postAction("send_tomorrow"), "send_tomorrow_done");
    expect(mocks.sendNextOrderTomorrow).toHaveBeenCalledWith(
      SHOP_DOMAIN,
      "ctr_1",
      expect.objectContaining({ source: "CUSTOMER_PORTAL", actor: "customer" }),
    );
    expect(url.searchParams.get("d1")).toBe(isoDay(addDaysTz(TODAY, 1, TZ)));
    expect(url.searchParams.get("d2")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(url.searchParams.get("undo")).toBe("UNDOTOKEN");
    expect(url.searchParams.get("cid")).toBe("ctr_1");
    const [, data] = mocks.createSignedPayload.mock.calls[0] as unknown as [
      string,
      { spec: { kind: string; previousNextBillingDate: string; nextBillingDate: string } },
    ];
    expect(data.spec.kind).toBe("next_date");
    expect(data.spec.previousNextBillingDate).toBe(NEXT_WEEK.toISOString());
    expect(data.spec.nextBillingDate).toBe(addDaysTz(TODAY, 1, TZ).toISOString());
  });

  it("is an ACCELERATION: allowed inside the plan lock window", async () => {
    setContract(lockedContract());
    expectToast(await postAction("send_tomorrow"), "send_tomorrow_done");
    expect(mocks.sendNextOrderTomorrow).toHaveBeenCalledTimes(1);
  });

  it("maps the typed refusals: PREPARING → preparing, PAYMENT_ISSUE / ALREADY_SOON → their own toasts, NOT_ACTIVE → error", async () => {
    mocks.sendNextOrderTomorrow.mockRejectedValueOnce(new mocks.SendTomorrowError("PREPARING"));
    expectToast(await postAction("send_tomorrow"), "preparing");
    mocks.sendNextOrderTomorrow.mockRejectedValueOnce(new mocks.SendTomorrowError("PAYMENT_ISSUE"));
    expectToast(await postAction("send_tomorrow"), "send_tomorrow_payment");
    mocks.sendNextOrderTomorrow.mockRejectedValueOnce(new mocks.SendTomorrowError("ALREADY_SOON"));
    expectToast(await postAction("send_tomorrow"), "send_tomorrow_soon");
    mocks.sendNextOrderTomorrow.mockRejectedValueOnce(new mocks.SendTomorrowError("NOT_ACTIVE"));
    expectToast(await postAction("send_tomorrow"), "error");
  });

  it("dedupes a stale expected_next (double-tap) to the success toast without a second pull, and is ACTIVE-only", async () => {
    expectToast(
      await postAction("send_tomorrow", { expected_next: new Date(NOW.getTime() + 30 * DAY_MS).toISOString() }),
      "send_tomorrow_done",
    );
    expect(mocks.sendNextOrderTomorrow).not.toHaveBeenCalled();
    setContract(pausedContract());
    expectToast(await postAction("send_tomorrow"), "error");
    expect(mocks.sendNextOrderTomorrow).not.toHaveBeenCalled();
  });
});

// ── delivery_instructions ────────────────────────────────────────────────────

describe("delivery_instructions", () => {
  it("saves the note through the service and reports saved vs cleared from the mirror", async () => {
    expectToast(
      await postAction("delivery_instructions", { instructions: "Leave with the neighbour at no. 12" }),
      "instructions_saved",
    );
    expect(mocks.setDeliveryInstructions).toHaveBeenCalledWith(
      SHOP_DOMAIN,
      "ctr_1",
      "Leave with the neighbour at no. 12",
      expect.objectContaining({ source: "CUSTOMER_PORTAL", actor: "customer" }),
    );
    expectToast(await postAction("delivery_instructions", { instructions: "   " }), "instructions_cleared");
    expectToast(await postAction("delivery_instructions", {}), "instructions_cleared");
  });

  it("is a delivery-detail edit: allowed on PAUSED and inside the lock window, refused on CANCELLED", async () => {
    setContract(pausedContract());
    expectToast(await postAction("delivery_instructions", { instructions: "Ring twice" }), "instructions_saved");
    setContract(lockedContract());
    expectToast(await postAction("delivery_instructions", { instructions: "Ring twice" }), "instructions_saved");
    expect(mocks.setDeliveryInstructions).toHaveBeenCalledTimes(2);
    setContract(makeContract({ status: "CANCELLED" }));
    expectToast(await postAction("delivery_instructions", { instructions: "Ring twice" }), "error");
    expect(mocks.setDeliveryInstructions).toHaveBeenCalledTimes(2);
  });

  it("refuses an abusive body length before it reaches the service", async () => {
    expectToast(await postAction("delivery_instructions", { instructions: "x".repeat(4001) }), "error");
    expect(mocks.setDeliveryInstructions).not.toHaveBeenCalled();
  });
});
