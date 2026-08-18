import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PAUSED banner "Change resume date" (v1.28.0, P2.6 UI) — the api action
 * `pause_resume_date` through the REAL dispatcher with the contracts service
 * mocked, plus the banner rendering pins and the resume_on toast:
 *
 *  - PAUSED only; the date shape is validated; today or earlier ⇒
 *    pause_date_past (Resume now is the honest control);
 *  - the SAME day as the current resume day ⇒ nothing to do — reported as
 *    the standing hold (paused_until + d1), no service call;
 *  - LATER ⇒ extendPause (a REDUCTION: lock-blocked with the friendly lock
 *    toast; the service's typed refusals map to pause_too_far / error);
 *  - EARLIER ⇒ resumeContract({ billOn: day }) — the hold ends now and the
 *    first order is scheduled ON that day (a RECOVERY: allowed inside the
 *    lock window); toast resume_on carries the day, no Undo form;
 *  - banner: the form posts /api/pause_resume_date with min = tomorrow and
 *    max = the pause maximum measured from the pause START (or the current
 *    day when locked); the copy states the next-order day; the pause card's
 *    date picker + reason select stay as pinned in tests/portal-flex-ui.
 */

process.env.APP_SIGNING_SECRET = "test-secret-for-pause-until-ui";

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
    resumeContract: vi.fn(
      async (_s: string, _c: string, _o?: { billOn?: Date | null }): Promise<unknown> => ({}),
    ),
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
  resumeContract: mocks.resumeContract,
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
import { resolveToast, toastTone, TOAST_KEYS } from "~/lib/portal/layout.server";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import en from "~/lib/i18n/locales/en.json";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const enMap = en as Record<string, string>;

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
  mocks.resumeContract.mockImplementation(
    async (_s: string, _c: string, o?: { billOn?: Date | null }) =>
      makeContract({ nextBillingDate: o?.billOn ?? addDaysTz(NOW, 3, TZ) }),
  );
  mocks.setDeliveryInstructions.mockImplementation(
    async (_s: string, _c: string, text: string | null) =>
      makeContract({ deliveryInstructions: text && text.trim() ? text.trim() : null }),
  );
});

// ── pause_resume_date ────────────────────────────────────────────────────────

describe("pause_resume_date (Change resume date)", () => {
  it("LATER than the current resume day → extendPause with that shop-day start; toast pause_extended + d1", async () => {
    const paused = pausedContract();
    setContract(paused);
    const later = addDaysTz(paused.resumeAt as unknown as Date, 10, TZ);
    const res = await postAction("pause_resume_date", { date: isoDay(later) });
    const url = expectToast(res, "pause_extended");
    expect(url.searchParams.get("d1")).toBe(isoDay(later));
    expect(url.searchParams.get("undo")).toBeNull();
    expect(mocks.extendPause).toHaveBeenCalledTimes(1);
    expect(mocks.extendPause.mock.calls[0][2].getTime()).toBe(shopDayStartUtc(later, TZ).getTime());
    expect(mocks.resumeContract).not.toHaveBeenCalled();
  });

  it("EARLIER than the current resume day → resumeContract({ billOn: day }); toast resume_on + d1, no undo", async () => {
    const paused = pausedContract();
    setContract(paused);
    const earlier = addDaysTz(paused.resumeAt as unknown as Date, -5, TZ);
    const res = await postAction("pause_resume_date", { date: isoDay(earlier) });
    const url = expectToast(res, "resume_on");
    expect(url.searchParams.get("d1")).toBe(isoDay(earlier));
    expect(url.searchParams.get("undo")).toBeNull();
    expect(mocks.resumeContract).toHaveBeenCalledTimes(1);
    const opts = mocks.resumeContract.mock.calls[0][2] as { billOn?: Date; source?: string };
    expect(opts.billOn?.getTime()).toBe(shopDayStartUtc(earlier, TZ).getTime());
    expect(opts.source).toBe("CUSTOMER_PORTAL");
    expect(mocks.extendPause).not.toHaveBeenCalled();
  });

  it("the SAME day → nothing changes: paused_until + d1, no service call", async () => {
    const paused = pausedContract();
    setContract(paused);
    const res = await postAction("pause_resume_date", { date: isoDay(paused.resumeAt as unknown as Date) });
    const url = expectToast(res, "paused_until");
    expect(url.searchParams.get("d1")).toBe(isoDay(paused.resumeAt as unknown as Date));
    expect(mocks.extendPause).not.toHaveBeenCalled();
    expect(mocks.resumeContract).not.toHaveBeenCalled();
  });

  it("today or earlier → pause_date_past (Resume now is the control); malformed date → error; ACTIVE → error", async () => {
    setContract(pausedContract());
    expectToast(await postAction("pause_resume_date", { date: isoDay(NOW) }), "pause_date_past");
    expectToast(await postAction("pause_resume_date", { date: isoDay(new Date(NOW.getTime() - 3 * DAY_MS)) }), "pause_date_past");
    expectToast(await postAction("pause_resume_date", { date: "next tuesday" }), "error");
    setContract(makeContract());
    expectToast(await postAction("pause_resume_date", { date: isoDay(NEXT_WEEK) }), "error");
    expect(mocks.extendPause).not.toHaveBeenCalled();
    expect(mocks.resumeContract).not.toHaveBeenCalled();
  });

  it("inside the plan lock window: LATER is a reduction (locked, friendly toast when on), EARLIER is a recovery (allowed)", async () => {
    const paused = lockedContract({
      status: "PAUSED",
      pausedAt: new Date(NOW.getTime() - DAY_MS),
      resumeAt: shopDayStartUtc(addDaysTz(NOW, 20, TZ), TZ),
      nextBillingDate: null,
    });
    setContract(paused);
    mocks.portalSettings = { friendlyLockMessaging: true };
    const later = addDaysTz(paused.resumeAt as unknown as Date, 7, TZ);
    const url = expectToast(await postAction("pause_resume_date", { date: isoDay(later) }), "locked");
    expect(url.searchParams.get("locked_days")).toBeTruthy();
    expect(mocks.extendPause).not.toHaveBeenCalled();

    const earlier = addDaysTz(paused.resumeAt as unknown as Date, -7, TZ);
    expectToast(await postAction("pause_resume_date", { date: isoDay(earlier) }), "resume_on");
    expect(mocks.resumeContract).toHaveBeenCalledTimes(1);
  });

  it("maps the service's typed refusal on the LATER path (too far carries the latest allowed day)", async () => {
    const paused = pausedContract();
    setContract(paused);
    const maxDay = shopDayStartUtc(addDaysTz(paused.pausedAt as unknown as Date, 90, TZ), TZ);
    mocks.extendPause.mockRejectedValueOnce(new mocks.PauseUntilError("RESUME_DATE_TOO_FAR", maxDay));
    const later = addDaysTz(paused.resumeAt as unknown as Date, 80, TZ);
    const url = expectToast(await postAction("pause_resume_date", { date: isoDay(later) }), "pause_too_far");
    expect(url.searchParams.get("d1")).toBe(isoDay(maxDay));
    mocks.extendPause.mockRejectedValueOnce(new mocks.PauseUntilError("NOT_LATER"));
    expectToast(await postAction("pause_resume_date", { date: isoDay(later) }), "error");
  });
});

// ── Toast + banner pins ──────────────────────────────────────────────────────

describe("resume_on toast + PAUSED banner rendering", () => {
  it("resume_on is a registered polite toast, date-aware, never carrying an Undo form", () => {
    expect(TOAST_KEYS.has("resume_on")).toBe(true);
    expect(toastTone("resume_on")).toBe("status");
    const withDay = resolveToast(
      new Request("https://cellexialabs.com/x?toast=resume_on&d1=2026-10-01&undo=UNDOTOKEN&cid=ctr_1"),
      "en",
      { csrfToken: "csrf", preview: null, contractIds: ["ctr_1"] } as never,
    );
    expect(withDay?.toast.text).toContain("October 1, 2026");
    expect(withDay?.toast.text).toContain("active again");
    expect(withDay?.toast.html).toBeUndefined();
    const plain = resolveToast(new Request("https://cellexialabs.com/x?toast=resume_on"), "en");
    expect(plain?.toast.text).toBe(enMap["portal.toast.resume_on"]);
  });

  it("the banner form posts pause_resume_date with a shop-day min/max and honest next-order copy (source + catalog pins)", () => {
    const src = readSource("app/routes/proxy.subscription.$id.tsx");
    const fn = src.slice(src.indexOf("function pausedBannerHtml("), src.indexOf("// ── Address"));
    expect(fn).toContain('api(ctx, "pause_resume_date")');
    expect(fn).toContain('type="date" name="date"');
    expect(fn).toContain('min="${dateInputValue(bounds.min, tz)}"');
    expect(fn).toContain('max="${dateInputValue(maxDay, tz)}"');
    // Locked ⇒ only earlier days (the current day is the max).
    expect(fn).toMatch(/input\.locked\s*\?\s*currentDay/);
    // Clamp measured from the pause START, like extendPause.
    expect(fn).toContain("contract.pausedAt ?? new Date()");
    expect(fn).toContain('api(ctx, "resume")');
    expect(fn).toContain('api(ctx, "pause_extend")');
    // Copy: paused-until names the next-order day; nothing names cancellation.
    expect(enMap["portal.detail.paused_until"]).toContain("next order");
    for (const key of [
      "portal.pause.change_date_label",
      "portal.pause.change_date_submit",
      "portal.pause.change_date_hint",
      "portal.toast.resume_on",
      "portal.toast.resume_on_date",
      "portal.detail.paused_until",
    ]) {
      expect(enMap[key]).toBeTruthy();
      expect(enMap[key].toLowerCase()).not.toMatch(/cancel/);
    }
    // The pause card (ACTIVE) keeps month presets + date picker + reasons.
    const pause = src.slice(src.indexOf("function pauseHtml("), src.indexOf("function pausedBannerHtml("));
    expect(pause).toContain('api(ctx, "pause_until")');
    expect(pause).toContain('api(ctx, "pause")');
    for (const r of ["TRAVEL", "TOO_MUCH", "BUDGET", "OTHER"]) expect(pause).toContain(r);
  });

  it("the dispatcher lists pause_resume_date and gates it PAUSED-only without a blanket lock block (direction decides)", () => {
    const src = readSource("app/routes/proxy.api.$action.tsx");
    expect(src).toContain('case "pause_resume_date"');
    const lockBlocked = src.slice(src.indexOf("const LOCK_BLOCKED = new Set(["), src.indexOf("]);", src.indexOf("const LOCK_BLOCKED = new Set([")));
    expect(lockBlocked).not.toContain("pause_resume_date");
    const activeOnly = src.slice(src.indexOf("const ACTIVE_ONLY = new Set(["), src.indexOf("]);", src.indexOf("const ACTIVE_ONLY = new Set([")));
    expect(activeOnly).not.toContain("pause_resume_date");
  });
});
